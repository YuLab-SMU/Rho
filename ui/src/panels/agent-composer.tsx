import type { ComponentProps, DragEventHandler, ReactNode } from "react";
import { AgentMessageInput } from "./agent-message-input";

/** Both task owners supply state to one input and control layout. */
export function AgentComposer({ input, children, tools, controls, onDragOver, onDrop }: {
  input: ComponentProps<typeof AgentMessageInput>;
  children?: ReactNode;
  tools: ReactNode;
  controls: ReactNode;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}) {
  return <div className={`at-composer${input.readOnly ? " readonly" : ""}`} onDragOver={onDragOver} onDrop={onDrop}>
    <div className="at-composer-content">{children}<AgentMessageInput {...input} /></div>
    <div className="at-composer-tools"><div className="at-input-tools">{tools}</div><div className="at-model-tools">{controls}</div></div>
  </div>;
}
