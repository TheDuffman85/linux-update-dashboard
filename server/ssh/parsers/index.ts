import type { PackageParser } from "./types";
import { aptParser } from "./apt";
import { dnfParser } from "./dnf";
import { yumParser } from "./yum";
import { pacmanParser } from "./pacman";
import { apkParser } from "./apk";
import { flatpakParser } from "./flatpak";
import { snapParser } from "./snap";
import { debGetParser } from "./deb-get";

export type { ParsedUpdate, PackageParser } from "./types";

const parsers: Record<string, PackageParser> = {
  apt: aptParser,
  dnf: dnfParser,
  yum: yumParser,
  pacman: pacmanParser,
  apk: apkParser,
  flatpak: flatpakParser,
  snap: snapParser,
  "deb-get": debGetParser,
};

export function getParser(name: string): PackageParser | undefined {
  return parsers[name];
}

export { aptParser, dnfParser, yumParser, pacmanParser, apkParser, flatpakParser, snapParser, debGetParser };
