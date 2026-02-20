import type { PackageParser } from "./types";
import { aptParser } from "./apt";
import { dnfParser } from "./dnf";
import { yumParser } from "./yum";
import { pacmanParser } from "./pacman";
import { flatpakParser } from "./flatpak";
import { snapParser } from "./snap";

export type { ParsedUpdate, PackageParser } from "./types";

const parsers: Record<string, PackageParser> = {
  apt: aptParser,
  dnf: dnfParser,
  yum: yumParser,
  pacman: pacmanParser,
  flatpak: flatpakParser,
  snap: snapParser,
};

export function getParser(name: string): PackageParser | undefined {
  return parsers[name];
}

export { aptParser, dnfParser, yumParser, pacmanParser, flatpakParser, snapParser };
