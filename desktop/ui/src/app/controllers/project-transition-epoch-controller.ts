export interface ProjectActivationScope {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectionGeneration: number;
}

export interface ProjectActionScope {
  readonly epoch: number;
  readonly projectId: string;
  readonly projectRevision: number;
}

export type ProjectTransitionEpochToken = Readonly<{ epoch: number }>;

interface TransitionRecord {
  readonly start: ProjectActivationScope;
  settledSource: ProjectActivationScope | null;
}

function sameActionScope(
  left: ProjectActionScope | null,
  right: ProjectActionScope | null,
): boolean {
  return left?.epoch === right?.epoch
    && left?.projectId === right?.projectId
    && left?.projectRevision === right?.projectRevision;
}

export class ProjectTransitionEpochController {
  #epoch = 0;
  #openScope: ProjectActionScope | null = null;
  #observedActivation: ProjectActivationScope | null = null;
  #activeToken: ProjectTransitionEpochToken | null = null;
  readonly #records = new WeakMap<ProjectTransitionEpochToken, TransitionRecord>();

  initialize(activation: ProjectActivationScope): ProjectActionScope {
    if (this.#epoch === 0) {
      this.#epoch = 1;
      this.#openScope = this.#actionScope(activation);
      this.#observedActivation = activation;
    }
    if (this.#openScope == null) {
      throw new Error("Project mutation admission is closed.");
    }
    return this.#openScope;
  }

  observeActivation(activation: ProjectActivationScope): ProjectActionScope {
    if (this.#epoch === 0) return this.initialize(activation);
    if (this.#activeToken != null || this.#openScope == null || this.#observedActivation == null) {
      throw new Error("Project mutation admission is closed.");
    }
    if (activation.projectId !== this.#observedActivation.projectId) {
      throw new Error("The project changed without a transition barrier.");
    }
    if (
      activation.projectRevision < this.#observedActivation.projectRevision
      || activation.projectionGeneration < this.#observedActivation.projectionGeneration
    ) {
      throw new Error("The open project activation moved backwards.");
    }
    this.#observedActivation = activation;
    this.#openScope = this.#actionScope(activation);
    return this.#openScope;
  }

  begin(activation: ProjectActivationScope): ProjectTransitionEpochToken {
    if (this.#activeToken != null || this.#openScope == null) {
      throw new Error("A project transition is already active or admission is closed.");
    }
    if (
      this.#observedActivation == null
      || this.#observedActivation.projectId !== activation.projectId
      || this.#observedActivation.projectRevision !== activation.projectRevision
      || this.#observedActivation.projectionGeneration !== activation.projectionGeneration
    ) {
      throw new Error("The open project activation changed before transition admission.");
    }
    const token = Object.freeze({ epoch: this.#epoch + 1 });
    this.#epoch = token.epoch;
    this.#activeToken = token;
    this.#openScope = null;
    this.#records.set(token, { start: activation, settledSource: null });
    return token;
  }

  captureSettledSource(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActivationScope {
    const record = this.#record(token);
    if (
      activation.projectId !== record.start.projectId
      || activation.projectRevision < record.start.projectRevision
      || activation.projectionGeneration < record.start.projectionGeneration
    ) {
      throw new Error("The source project changed while admitted work was settling.");
    }
    record.settledSource = activation;
    return activation;
  }

  acceptReady(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActionScope {
    const source = this.#settledSource(token);
    if (activation.projectionGeneration <= source.projectionGeneration) {
      throw new Error("The accepted project did not advance the Workbench projection generation.");
    }
    if (
      activation.projectId === source.projectId
      && activation.projectRevision <= source.projectRevision
    ) {
      throw new Error("The re-opened project did not advance its project revision.");
    }
    return this.#reopen(token, activation);
  }

  acceptRestored(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActionScope {
    const source = this.#settledSource(token);
    if (
      activation.projectId !== source.projectId
      || activation.projectRevision <= source.projectRevision
      || activation.projectionGeneration <= source.projectionGeneration
    ) {
      throw new Error("The restored project activation did not advance exact source truth.");
    }
    return this.#reopen(token, activation);
  }

  acceptNoChange(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActionScope {
    const source = this.#settledSource(token);
    if (
      activation.projectId !== source.projectId
      || activation.projectRevision !== source.projectRevision
      || activation.projectionGeneration < source.projectionGeneration
    ) {
      throw new Error("The project changed despite a no-change switch outcome.");
    }
    return this.#reopen(token, activation);
  }

  recoverPrevious(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActionScope {
    const source = this.#settledSource(token);
    if (
      activation.projectId !== source.projectId
      || activation.projectRevision < source.projectRevision
      || activation.projectionGeneration <= source.projectionGeneration
    ) {
      throw new Error("The previous project could not be proven coherent after transition failure.");
    }
    return this.#reopen(token, activation);
  }

  seal(token: ProjectTransitionEpochToken): void {
    this.#record(token);
    this.#activeToken = null;
    this.#openScope = null;
    this.#observedActivation = null;
  }

  currentActionScope(): ProjectActionScope | null {
    return this.#openScope;
  }

  accepts(scope: ProjectActionScope | null): boolean {
    return sameActionScope(this.#openScope, scope);
  }

  isAdmissionOpen(): boolean {
    return this.#openScope != null && this.#activeToken == null;
  }

  isInitialized(): boolean {
    return this.#epoch > 0;
  }

  #record(token: ProjectTransitionEpochToken): TransitionRecord {
    if (token !== this.#activeToken) {
      throw new Error("The project transition epoch token is no longer current.");
    }
    const record = this.#records.get(token);
    if (record == null) throw new Error("The project transition epoch token is invalid.");
    return record;
  }

  #settledSource(token: ProjectTransitionEpochToken): ProjectActivationScope {
    const source = this.#record(token).settledSource;
    if (source == null) throw new Error("The project transition source has not settled.");
    return source;
  }

  #reopen(
    token: ProjectTransitionEpochToken,
    activation: ProjectActivationScope,
  ): ProjectActionScope {
    this.#record(token);
    const scope = this.#actionScope(activation);
    this.#activeToken = null;
    this.#openScope = scope;
    this.#observedActivation = activation;
    return scope;
  }

  #actionScope(activation: ProjectActivationScope): ProjectActionScope {
    return Object.freeze({
      epoch: this.#epoch,
      projectId: activation.projectId,
      projectRevision: activation.projectRevision,
    });
  }
}
