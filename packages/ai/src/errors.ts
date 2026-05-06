export class AgentNotFoundError extends Error {
  constructor(clinicId: string, agentName: string) {
    super(`No published agent_config found for clinic=${clinicId} name=${agentName}`);
    this.name = 'AgentNotFoundError';
  }
}

export class NamespacingViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamespacingViolationError';
  }
}

export class AgentDispatchSkipped extends Error {
  constructor(public readonly reason: 'state_not_ai_handling' | 'no_agent_config' | 'cross_tenant') {
    super(`dispatchAgent skipped: ${reason}`);
    this.name = 'AgentDispatchSkipped';
  }
}
