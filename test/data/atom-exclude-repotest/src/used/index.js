import leftPad from "left-pad";

export function padMessage(message) {
  return leftPad(message, 5, "0");
}
