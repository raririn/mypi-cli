export const GUI_CONTROL_STATE_EVENT = "mypi:gui-control-state";

export interface GuiControlStateEvent {
  readonly state: "disabled" | "discovering" | "connecting" | "handshaking" | "connected" | "backoff" | "closing";
  readonly connected: boolean;
}
