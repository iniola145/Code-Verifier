# Project-specific conventions

Go Engineer uses general Go backend guidance for every repository. A repository may optionally add .go-engineer.yaml at its root to describe project-specific conventions. The file is read-only input and is never generated or modified by the MCP server.

Example configuration:

Configuration files must declare `version: 1`. Omitted settings mean “not configured”; they do not receive an architectural default. Optional booleans preserve this distinction, so explicit `false` differs from omission.

    version: 1
    project:
      architecture: layered
    http:
      router: chi
    packages:
      handlers:
        - internal/handlers
      services:
        - internal/services
      repositories:
        - internal/repositories
    database:
      direct_access_from_handlers: false
    errors:
      classification: errors-is-as
    context:
      require_propagation: true
    testing:
      default_package: ./...

The database setting explicitly states that this repository disallows direct handler/database coupling. A file containing only `version: 1` does not make that project-specific statement.

General guidance remains reusable across projects. Project conventions specialize that guidance for the configured repository; they are not universal Go best practices. When .go-engineer.yaml is absent, the server continues using general defaults and heuristic review signals.
