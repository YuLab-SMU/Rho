import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentUsage, latestUsage } from "../src/panels/agent-usage";
import type { AgentTaskEvent } from "../src/generated/AgentTaskEvent";
const observation = (usage: Partial<NonNullable<AgentTaskEvent["usage"]>>): AgentTaskEvent => ({ sequence:1,event_id:"usage",request_id:null,generation:1,native_session_id:"s",native_turn_id:null,native_item_id:null,kind:"usage",role:null,text:"",status:null,source:"observation",observed_at_ms:1,usage:{source:"native",scope:"session_total",input_tokens:null,output_tokens:null,cached_input_tokens:null,cache_write_tokens:null,reasoning_tokens:null,total_tokens:null,context_used:null,context_capacity:null,...usage} });
it("replaces cumulative usage observations and preserves explicit zero separately from unknown", () => {
  const events=[observation({input_tokens:120,output_tokens:5}),observation({input_tokens:180,output_tokens:0})];
  expect(latestUsage(events)).toMatchObject([{input_tokens:180,output_tokens:0,total_tokens:null}]);
  const view=render(<AgentUsage events={events} />);
  expect(screen.getByText("180")).toBeTruthy(); expect(screen.getByText("0")).toBeTruthy(); expect(screen.queryByText("300")).toBeNull();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0); view.unmount();
});
it("labels ACP context occupancy independently of token consumption", () => {
  const view=render(<AgentUsage events={[observation({scope:"context_window",context_used:2400,context_capacity:32000})]} />);
  expect(screen.getByText("Context used")).toBeTruthy(); expect(screen.getByText("2400")).toBeTruthy(); expect(screen.queryByText("Input tokens")).toBeNull(); view.unmount();
});
