import { useContext } from "react";
import { RoomContext, type RoomContextValue } from "./roomContext.ts";

/** The room's state and actions. The only way components talk to the engine. */
export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error("useRoom() must be used inside <RoomProvider>");
  return value;
}
