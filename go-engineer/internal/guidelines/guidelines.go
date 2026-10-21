package guidelines

type Guideline struct{ URI, Name, Description, Content string }

var all = []Guideline{
	{"go://guidelines/api-design", "Go API design", "General REST API design guidance.", apiDesign},
	{"go://guidelines/handlers", "Go HTTP handlers", "HTTP handler responsibilities.", handlers},
	{"go://guidelines/services", "Go services", "Application and service-layer guidance.", services},
	{"go://guidelines/error-handling", "Go error handling", "Idiomatic error handling guidance.", errorHandling},
	{"go://guidelines/testing", "Go backend testing", "Testing guidance for Go services and APIs.", testingGuidance},
	{"go://guidelines/context", "Go context", "Context propagation and cancellation.", contextGuidance},
	{"go://guidelines/concurrency", "Go concurrency", "Safe concurrency guidance.", concurrency},
}

func All() []Guideline { return append([]Guideline(nil), all...) }
func Find(uri string) (Guideline, bool) {
	for _, item := range all {
		if item.URI == uri {
			return item, true
		}
	}
	return Guideline{}, false
}

const apiDesign = `# Go backend API design

These are general principles, not a mandate for one framework or architecture.

- Prefer resource-oriented routes: POST /users, GET /users/{id}, PATCH /users/{id}, DELETE /users/{id}.
- Use HTTP methods according to their semantics. Keep GET safe and design retries and idempotency deliberately.
- Put identity in the path and filtering, pagination, and sorting in query parameters. Validate limits and sort fields.
- Use request and response DTOs at the HTTP boundary; do not expose persistence models accidentally.
- Validate shape at the boundary and enforce business invariants in application logic.
- Use consistent status codes: 2xx success, 400 malformed input, 401/403 access failures, 404 missing resources, 409 conflicts, and 5xx server failures.
- Return a consistent JSON error shape without leaking internal details.
- Document pagination, filtering, sorting, and compatibility. Version APIs when compatibility requires it.
- Avoid RPC-style routes when resource semantics fit. Action endpoints can be reasonable for commands such as POST /users/{id}/activate.
`

const handlers = `# Go HTTP handlers

- Decode input, validate request shape, integrate authentication and authorization, call application logic, map domain errors, and write responses.
- Keep business rules, direct database queries, long transactions, and unrelated orchestration out of handlers.
- Pass request context downstream and map domain errors to HTTP at this boundary.
- Use constructors for dependency wiring when useful, without unnecessary containers.
`

const services = `# Go services

- Put business rules and application orchestration in services or use-case functions, independent of HTTP where practical.
- Accept context.Context for request-bound work and pass it to repositories and clients.
- Use narrow interfaces when substitution, boundaries, or focused testing provide value; do not create interfaces for every type.
- Keep transaction boundaries explicit and return meaningful domain or application errors.
`

const errorHandling = `# Go error handling

- Check errors explicitly and add context with %w, for example: return fmt.Errorf("load user %q: %w", id, err).
- Use errors.Is for sentinel classification and errors.As for typed errors. Do not compare error strings.
- Preserve the original cause and translate domain errors to HTTP at the transport boundary.
- Do not panic for ordinary input or runtime failures.
`

const testingGuidance = `# Go backend testing

- Test observable behavior and important failure paths. Use table-driven tests where cases share setup.
- Keep unit tests deterministic and use integration tests for real external boundaries.
- Prefer narrow interfaces or small fakes when substitution helps; avoid mocks that mirror implementation.
- Use t.TempDir for filesystem fixtures and httptest for HTTP handlers. Keep fixtures understandable.
`

const contextGuidance = `# Go context

- Make context.Context the first parameter of request-bound functions and propagate it through layers.
- Respect cancellation and deadlines around I/O and goroutines.
- Do not store contexts in structs or use context.Background inside request-bound code when a caller context exists.
- Use context for cancellation, deadlines, and request-scoped values, not ordinary optional parameters.
`

const concurrency = `# Go concurrency

- Give every goroutine clear ownership and a shutdown path to avoid leaks.
- Use channels for coordination and mutexes for shared mutable state when clearer.
- Use sync.WaitGroup or structured coordination, bound concurrency, and propagate cancellation.
- Use worker pools only when justified. Avoid concurrency unless it improves correctness or measured performance.
- Use go test -race ./... where applicable to detect data races.
`
