#!/usr/bin/env bash
# Builds each app's schema, at the commit that holds its known bugs, into the
# corpus databases that cartridge.json declares (docs/checker/corpus.md, part 2).
# Run `ops dev db up` first. Usage: scripts/corpus-build.sh [corpus-name...]
#
# Each database is reset, then built with psql as its migration login, whose
# sessions run as the owner role, so the owner owns every object and binds the
# default privileges, as in a graphile-migrate build. A `_base` database gets
# committed migrations only; the others get committed + current.
set -euo pipefail
shopt -s nullglob

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# .env values are not shell-quoted (ROOT_DATABASE_URL holds an "&"), so read
# only the corpus URLs, which are plain.
while IFS== read -r key value; do
	export "$key=$value"
done < <(grep "^CORPUS_" .env)
scratch_root=$(mktemp -d)
trap 'rm -rf "$scratch_root"' EXIT

# name | repo | commit | .gmrc search_path
corpus=(
	"setlist|setlist|5775660|app_public,app_private,app_hidden,public"
	"setlist_base|setlist|5775660|app_public,app_private,app_hidden,public"
	"dfg_rocks|dfg.rocks|5d9f334|app_public,app_private,public"
	"dfg_rocks_base|dfg.rocks|5d9f334|app_public,app_private,public"
	"template|effect-web-template|db51b82|app_public,app_private,app_hidden,public"
	"dfg_codes|dfg.codes|9ce49aa|public,auth,hidden"
)

main() {
	local entry name
	for entry in "${corpus[@]}"; do
		name=${entry%%|*}
		if (($# == 0)) || [[ " $* " == *" $name "* ]]; then
			build "$entry"
		fi
	done
}

build() {
	local name repo commit search_path db url scratch
	IFS='|' read -r name repo commit search_path <<<"$1"
	db="effect_backend_$name"
	url_var="CORPUS_${name^^}_URL"
	url=${!url_var}
	scratch="$scratch_root/$name"
	mkdir "$scratch"

	echo "== $db: $repo@$commit"
	ops dev db reset "$db" >/dev/null
	git -C "$HOME/build/$repo" archive "$commit" migrations | tar -x -C "$scratch"

	if [[ $repo == dfg.rocks ]]; then
		# Committed 000001 calls graphile_worker at top level, so the worker
		# schema must exist first; the repo pins graphile-worker 0.16.6.
		DATABASE_URL=$url bun --cwd="$HOME/build/dfg.rocks/worker" graphile-worker --schema-only >/dev/null
		# afterReset.sql uses the placeholder inside a do $$ body, which psql
		# does not substitute.
		sed -i "s/:DATABASE_VISITOR/${db}_visitor/g" "$scratch/migrations/afterReset.sql"
	fi

	local files=("$scratch/migrations/afterReset.sql" "$scratch"/migrations/committed/*.sql)
	if [[ $name != *_base ]]; then
		files+=("$scratch"/migrations/current/*.sql)
	fi

	local file
	for file in "${files[@]}"; do
		PGOPTIONS="-c search_path=$search_path -c client_min_messages=warning" psql "$url" -q -X -1 \
			-v ON_ERROR_STOP=1 \
			-v DATABASE_NAME="$db" \
			-v DATABASE_OWNER="${db}_owner" \
			-v DATABASE_VISITOR="${db}_visitor" \
			-v DATABASE_AUTHENTICATOR="alchemy_${db}_api" \
			-f "$file" >/dev/null
	done
	echo "   built from ${#files[@]} files"
}

main "$@"
