# SQL function drift

Generated 2026-10-31 by `bun scripts/sqlDrift.ts` from each app's migrations (committed, then current; the last definition wins). Each letter is one distinct function body after removing comments and whitespace; `-` means absent. graphile-starter-slim is the common ancestor.

```
function	graphile-s	effect-web	setlist	postgres.g	dfg.rocks
assert_valid_password         	A	B	B	B	B
change_password               	A	B	C	D	E
confirm_account_deletion      	A	B	A	A	A
current_session_id            	A	B	B	C	B
current_user_id               	A	A	A	B	B
forgot_password               	A	B	A	A	A
link_or_register_user         	A	B	C	D	C
login                         	A	B	A	C	A
logout                        	A	B	B	C	C
make_email_primary            	A	A	A	A	A
really_create_user            	A	B	C	D	C
register_user                 	A	B	A	C	A
request_account_deletion      	A	B	A	A	A
resend_email_verification_code	A	B	A	A	A
reset_password                	A	B	C	D	C
tg__add_audit_job             	A	A	A	A	A
tg__add_job                   	A	A	A	A	A
tg__timestamps                	A	A	A	A	A
users_has_password            	A	A	A	A	A
verify_email                  	A	B	A	A	A
```
