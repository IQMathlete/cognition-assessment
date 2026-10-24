export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "The requested resource was not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// Thrown by approval hooks when the decision does not apply to the entity —
// e.g. a request is not the entity's linked approval. decideApproval records
// the refusal and treats it as a handled outcome, not a system failure.
export class HookRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookRefusalError";
  }
}
