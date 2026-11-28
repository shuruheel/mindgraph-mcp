import { describe, expect, it } from "vitest";
import { MindGraphError, type MindGraph } from "mindgraph";
import { handleTool } from "../src/tools.js";
import { BOARD_MANAGED_CARD_ERROR_CODE } from "../src/story-contract.js";

describe("mindgraph_plan board-managed story card write fencing", () => {
  it("returns structured boardManagedWriteRefusal when Cloud rejects a board-managed card mutation with 403", async () => {
    const fakeClient = {
      plan: async () => {
        throw new MindGraphError(
          "Forbidden",
          403,
          { code: BOARD_MANAGED_CARD_ERROR_CODE, card_uid: "citation-source" },
        );
      },
    } as unknown as MindGraph;

    const result = await handleTool(fakeClient, "mindgraph_plan", {
      action: "update_status",
      task_uid: "citation-source",
      status: "done",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      error: BOARD_MANAGED_CARD_ERROR_CODE,
      code: BOARD_MANAGED_CARD_ERROR_CODE,
      card_uid: "citation-source",
      required_surface: "board_api",
      status: 403,
      retriable: false,
    });
    expect(result.structuredContent).toEqual(parsed);
  });

  it("falls back to task_uid from mindgraph_plan args when server omits card_uid in a 409 body", async () => {
    const fakeClient = {
      plan: async () => {
        throw new MindGraphError(
          "Conflict",
          409,
          { error: BOARD_MANAGED_CARD_ERROR_CODE, current_version: 4 },
        );
      },
    } as unknown as MindGraph;

    const result = await handleTool(fakeClient, "mindgraph_plan", {
      action: "claim_task",
      task_uid: "card:citation-source",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      error: BOARD_MANAGED_CARD_ERROR_CODE,
      code: BOARD_MANAGED_CARD_ERROR_CODE,
      card_uid: "card:citation-source",
      required_surface: "board_api",
      current_version: 4,
      status: 409,
      retriable: false,
    });
  });
});
