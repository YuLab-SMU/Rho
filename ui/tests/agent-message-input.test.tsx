import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentMessageInput } from "../src/panels/agent-message-input";
afterEach(cleanup);
function props() {
  return {value:"",placeholder:"Message",readOnly:false,canSubmit:true,onChange:vi.fn(),onCompositionCommit:vi.fn(),onComposingChange:vi.fn(),onSubmit:vi.fn(),onEscape:vi.fn(),onMention:vi.fn(),onPaste:vi.fn()};
}
it("keeps native preedit intact when a draft acknowledgement changes the external value",()=>{
  const p=props(), view=render(<AgentMessageInput {...p} value="previous " />);
  const input=view.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:'previous zhong'}});
  view.rerender(<AgentMessageInput {...p} value="" />);
  expect(input.value).toBe('previous zhong');expect(p.onChange).not.toHaveBeenCalled();expect(p.onCompositionCommit).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'previous 中文'}});fireEvent.compositionEnd(input,{data:'中文'});
  expect(p.onCompositionCommit).toHaveBeenCalledExactlyOnceWith('previous 中文');
  fireEvent.change(input,{target:{value:'previous 中文'}});expect(p.onChange).not.toHaveBeenCalled();
  view.rerender(<AgentMessageInput {...p} value="previous 中文" />);expect(input.value).toBe('previous 中文');
  view.rerender(<AgentMessageInput {...p} value="next saved draft" />);expect(input.value).toBe('next saved draft');
});
it("composition keys never send or open a context picker, including 229 and post-composition Enter",()=>{
  const p=props(), shortcut=vi.fn(), view=render(<div onKeyDown={shortcut}><AgentMessageInput {...p} /></div>),input=view.getByRole('textbox');
  fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:'ni@'}});fireEvent.keyDown(input,{key:'Escape'});fireEvent.keyDown(input,{key:'Enter'});
  expect(p.onSubmit).not.toHaveBeenCalled();expect(p.onEscape).not.toHaveBeenCalled();expect(p.onMention).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'你'}});fireEvent.compositionEnd(input,{data:'你'});
  fireEvent.keyDown(input,{key:'Enter',keyCode:229,isComposing:false,ctrlKey:true});expect(shortcut).not.toHaveBeenCalled();fireEvent.keyDown(input,{key:'Enter',isComposing:false});expect(p.onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Enter',shiftKey:true});expect(p.onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Enter'});expect(p.onSubmit).toHaveBeenCalledTimes(1);
});
it("forwards composition completion for conflict retention if control changes before the candidate is committed",()=>{
  const p=props(),view=render(<AgentMessageInput {...p} value="local " />),input=view.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:'local zhong'}});
  view.rerender(<AgentMessageInput {...p} value="other window" readOnly />);expect(input.value).toBe('local zhong');
  fireEvent.change(input,{target:{value:'local 中文'}});fireEvent.compositionEnd(input,{data:'中文'});
  expect(p.onCompositionCommit).toHaveBeenCalledWith('local 中文');expect(p.onChange).not.toHaveBeenCalled();
});

it("remeasures on panel-width changes without rewriting an active native preedit",()=>{
  let resized!:()=>void;
  vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});
  try {
    const p=props(),view=render(<AgentMessageInput {...p} value="A saved multiline draft"/>),input=view.getByRole("textbox") as HTMLTextAreaElement;
    let width=400;
    Object.defineProperty(input,"clientWidth",{get:()=>width}); Object.defineProperty(input,"scrollHeight",{get:()=>width<250?88:54});
    resized();expect(input.style.height).toBe("54px");width=220;resized();expect(input.style.height).toBe("88px");
    fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:"A saved multiline draft zhong"}});width=400;resized();
    expect(input.style.height).toBe("88px");expect(input.value).toContain("zhong");expect(p.onCompositionCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input,{data:"中"});expect(input.style.height).toBe("54px");
  } finally {cleanup();vi.unstubAllGlobals();}
});
