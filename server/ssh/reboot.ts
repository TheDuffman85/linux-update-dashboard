import { sudo } from "./parsers/types";

export function getRebootCommand(): string {
  return sudo("reboot");
}
