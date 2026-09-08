# Legacy nutrition reality-data migration

Deploy the unified kitchen-planner Skill. Its installer also supplies a small
nutrition-ledger CLI compatibility directory without SKILL.md. Ingredient commands use the internal nutrition module;
legacy recipe/meal/day/week CLI commands forward to kitchen-planner with the
nutrition root fixed. They never resume writing old reality-data locations.

1. Confirm the source nutrition root and separate destination kitchen root.
   Stop concurrent old-version writers during the eventual approved cutover.
2. Run `kitchen-planner.mjs migrate --nutrition-root ... --data-root ...`.
   This reads legacy recipes, monthly meals, profile and explicitly recipe/meal/
   goal/menu-related pending entries. It does not inspect conversations or guess
   inventory. Ambiguous pending entries stay at source for manual classification.
3. Review counts and conflicts. `--apply` is separately authorized for production.
   Conflicting immutable IDs or a different existing profile block the complete
   import; do not force an overwrite. Apply writes a private byte backup in
   `migration-backup/`, keeps source files unchanged, and imports all destination
   records in one recoverable transaction.
4. Compare source/destination counts and snapshots; repeat migration and require
   unchanged. Run `validate`, then `rebuild` if consumption caches are missing.
   Check recipe calculation and day/week summaries on the destination.
5. Leave legacy source files as retained migration backups, not live writable
   reality data. Pending entries copied from legacy source remain there for
   recovery but are no longer presented by nutrition ingredient review commands.
   Do not delete backups or rewrite Git history during cutover.

Private paths and raw records must not enter public tests/logs/commits. Private
Git persistence requires verified private remote and exact task-path staging.
The migration tool does not commit, push, alter secrets or update any daemon.
Old directory discovery links may remain for command compatibility, but cannot
advertise a second Skill because their runtime target has no SKILL.md. Custom
standalone copies of old Skill instructions are not automatically deleted.
