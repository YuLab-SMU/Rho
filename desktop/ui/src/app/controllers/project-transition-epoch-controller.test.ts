import { describe, expect, it } from "vitest";

import {
  ProjectTransitionEpochController,
  type ProjectActivationScope,
} from "./project-transition-epoch-controller";

function activation(
  projectId: string,
  projectRevision: number,
  projectionGeneration: number,
): ProjectActivationScope {
  return { projectId, projectRevision, projectionGeneration };
}

describe("Project transition epoch controller", () => {
  it("invalidates the old action scope synchronously and opens only the accepted activation", () => {
    const controller = new ProjectTransitionEpochController();
    const source = activation("project:a", 1, 10);
    const oldScope = controller.initialize(source);
    const token = controller.begin(source);
    expect(controller.accepts(oldScope)).toBe(false);
    expect(controller.isAdmissionOpen()).toBe(false);
    controller.captureSettledSource(token, source);
    const targetScope = controller.acceptReady(token, activation("project:b", 1, 11));
    expect(targetScope).toMatchObject({ epoch: 2, projectId: "project:b", projectRevision: 1 });
    expect(controller.accepts(targetScope)).toBe(true);
    expect(controller.isAdmissionOpen()).toBe(true);
  });

  it("uses the post-drain settled source rather than transition-start generation", () => {
    const controller = new ProjectTransitionEpochController();
    const start = activation("project:a", 4, 20);
    controller.initialize(start);
    const token = controller.begin(start);
    controller.captureSettledSource(token, activation("project:a", 5, 22));
    expect(() => controller.acceptNoChange(token, activation("project:a", 4, 20)))
      .toThrow("no-change");
    expect(controller.acceptNoChange(token, activation("project:a", 5, 22)))
      .toMatchObject({ epoch: 2, projectId: "project:a", projectRevision: 5 });
  });

  it("observes ordinary same-project activation advances before the next barrier", () => {
    const controller = new ProjectTransitionEpochController();
    const initial = activation("project:a", 1, 10);
    controller.initialize(initial);
    const advanced = activation("project:a", 2, 11);
    expect(controller.observeActivation(advanced)).toMatchObject({
      epoch: 1,
      projectId: "project:a",
      projectRevision: 2,
    });
    expect(() => controller.begin(advanced)).not.toThrow();

    const regressedRevision = new ProjectTransitionEpochController();
    regressedRevision.initialize(advanced);
    expect(() => regressedRevision.observeActivation(activation("project:a", 1, 12)))
      .toThrow("backwards");
    expect(() => regressedRevision.observeActivation(activation("project:a", 2, 9)))
      .toThrow("backwards");

    const changedProject = new ProjectTransitionEpochController();
    changedProject.initialize(initial);
    expect(() => changedProject.observeActivation(activation("project:b", 1, 11)))
      .toThrow("without a transition barrier");
  });

  it("requires same-identity ready and restored outcomes to advance project revision", () => {
    const readyController = new ProjectTransitionEpochController();
    const source = activation("project:a", 7, 30);
    readyController.initialize(source);
    const readyToken = readyController.begin(source);
    readyController.captureSettledSource(readyToken, source);
    expect(() => readyController.acceptReady(readyToken, activation("project:a", 7, 31)))
      .toThrow("project revision");
    expect(readyController.acceptReady(readyToken, activation("project:a", 8, 31)))
      .toMatchObject({ projectRevision: 8 });

    const restoredController = new ProjectTransitionEpochController();
    restoredController.initialize(source);
    const restoredToken = restoredController.begin(source);
    restoredController.captureSettledSource(restoredToken, source);
    expect(() => restoredController.acceptRestored(
      restoredToken,
      activation("project:b", 8, 31),
    )).toThrow("restored");
    expect(restoredController.acceptRestored(
      restoredToken,
      activation("project:a", 8, 31),
    )).toMatchObject({ projectId: "project:a", projectRevision: 8 });
  });

  it("recovers only coherent previous-project truth and keeps fatal admission closed", () => {
    const recoverable = new ProjectTransitionEpochController();
    const source = activation("project:a", 2, 40);
    recoverable.initialize(source);
    const token = recoverable.begin(source);
    recoverable.captureSettledSource(token, source);
    expect(() => recoverable.recoverPrevious(token, activation("project:b", 1, 41)))
      .toThrow("previous project");
    expect(() => recoverable.recoverPrevious(token, activation("project:a", 3, 40)))
      .toThrow("previous project");
    expect(recoverable.recoverPrevious(token, activation("project:a", 3, 41)))
      .toMatchObject({ projectId: "project:a", projectRevision: 3 });

    const fatal = new ProjectTransitionEpochController();
    fatal.initialize(source);
    const fatalToken = fatal.begin(source);
    fatal.captureSettledSource(fatalToken, source);
    fatal.seal(fatalToken);
    expect(fatal.currentActionScope()).toBeNull();
    expect(fatal.isAdmissionOpen()).toBe(false);
    expect(() => fatal.initialize(source)).toThrow("closed");
  });

  it("rejects forged and superseded transition tokens", () => {
    const controller = new ProjectTransitionEpochController();
    const source = activation("project:a", 1, 1);
    controller.initialize(source);
    const token = controller.begin(source);
    expect(() => controller.captureSettledSource({ epoch: token.epoch }, source))
      .toThrow("no longer current");
    controller.captureSettledSource(token, source);
    controller.acceptNoChange(token, source);
    expect(() => controller.seal(token)).toThrow("no longer current");
  });
});
