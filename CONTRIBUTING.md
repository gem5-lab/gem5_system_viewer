# Contributing

Keep changes focused and preserve evidence provenance. A missing record must not
silently become an idle state or an invented transaction.

Run the Python tests and JavaScript syntax check in README.md. Add replay tests
when changing timestamp handling, event identity, state propagation, or adapters.
Use small synthetic fixtures and label them clearly. Do not commit private
traces, generated SQLite databases, local filesystem paths, or credentials.

The backend consists of `model.py` (import/replay) and `viewer.py` (CLI/local HTTP
server). Frontend sources live in `dist/`. Documentation of structured capture
contracts belongs in TRACE_SCHEMA.md. No frontend build step is needed.

When reporting a problem, include the Python/SQLite/Graphviz/browser versions,
a minimal sanitized fixture when possible, reproduction commands, expected
behavior, and actual output.
