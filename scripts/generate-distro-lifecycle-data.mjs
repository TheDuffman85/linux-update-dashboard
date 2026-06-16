import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUTPUT_FILE = "server/generated/distro-lifecycle-data.json";
const DEFAULT_CATALOG_FILE = "server/default-distro-lifecycle-catalog.json";
const API_BASE_URL = "https://endoflife.date/api";
const CUSTOM_CATALOG_FILE = process.env.LUDASH_EOL_CATALOG_FILE?.trim();

const PRODUCTS = [
  { key: "ubuntu", product: "ubuntu", label: "Ubuntu", cycle: "majorMinor" },
  { key: "debian", product: "debian", label: "Debian", cycle: "major", supportField: "eol", eolField: "extendedSupport" },
  { key: "fedora", product: "fedora", label: "Fedora", cycle: "major" },
  { key: "rhel", product: "rhel", label: "Red Hat Enterprise Linux", cycle: "major", supportField: "support" },
  { key: "rocky", product: "rocky-linux", label: "Rocky Linux", cycle: "major", supportField: "support" },
  { key: "almalinux", product: "almalinux", label: "AlmaLinux", cycle: "major", supportField: "support" },
  { key: "centos", product: "centos", label: "CentOS", cycle: "major" },
  { key: "centos-stream", product: "centos-stream", label: "CentOS Stream", cycle: "major" },
  { key: "alpine", product: "alpine", label: "Alpine Linux", cycle: "majorMinor" },
  { key: "proxmox", product: "proxmox-ve", label: "Proxmox VE", cycle: "major" },
];

function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeEol(value) {
  if (value === false || isDateString(value)) return value;
  return null;
}

function normalizeCycle(value, mode) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return raw;
  return mode === "majorMinor" && match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function compareCyclesDesc(a, b) {
  const aParts = String(a.cycle).split(".").map((part) => Number.parseInt(part, 10));
  const bParts = String(b.cycle).split(".").map((part) => Number.parseInt(part, 10));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return String(b.cycle).localeCompare(String(a.cycle));
}

async function fetchProduct(product) {
  const res = await fetch(`${API_BASE_URL}/${product}.json`, {
    headers: { "User-Agent": "linux-update-dashboard lifecycle generator" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${product}: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected ${product} response shape`);
  }
  return data;
}

async function generatedFileExists() {
  try {
    await access(OUTPUT_FILE);
    return true;
  } catch {
    return false;
  }
}

function buildProductCatalog(product, rows) {
  const entries = [];
  const seenCycles = new Set();

  for (const row of rows) {
    const cycle = normalizeCycle(row.cycle, product.cycle);
    if (!cycle || seenCycles.has(cycle)) continue;

    const fallbackEol = normalizeEol(row.eol);
    const configuredEol = product.eolField ? normalizeEol(row[product.eolField]) : null;
    const eol = configuredEol ?? fallbackEol;
    if (eol === null) continue;

    const entry = { cycle, eol };
    const supportEnd = product.supportField ? normalizeEol(row[product.supportField]) : null;
    if (isDateString(supportEnd) && supportEnd !== eol) {
      entry.supportEnd = supportEnd;
    }

    entries.push(entry);
    seenCycles.add(cycle);
  }

  entries.sort(compareCyclesDesc);
  return { label: product.label, entries };
}

async function loadCatalogFile(path) {
  const content = await readFile(path, "utf8");
  const catalog = JSON.parse(content);
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return catalog;
}

function formatGeneratedCatalog(catalog, source = API_BASE_URL) {
  return `${JSON.stringify({
    source,
    generatedAt: new Date().toISOString(),
    catalog,
  }, null, 2)}\n`;
}

try {
  if (CUSTOM_CATALOG_FILE) {
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    await writeFile(
      OUTPUT_FILE,
      formatGeneratedCatalog(await loadCatalogFile(CUSTOM_CATALOG_FILE), CUSTOM_CATALOG_FILE),
    );
    console.log(`Generated ${OUTPUT_FILE} from ${CUSTOM_CATALOG_FILE}`);
    process.exit(0);
  }

  const catalog = {};
  for (const product of PRODUCTS) {
    const rows = await fetchProduct(product.product);
    catalog[product.key] = buildProductCatalog(product, rows);
  }

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, formatGeneratedCatalog(catalog));
  console.log(`Generated ${OUTPUT_FILE}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (await generatedFileExists()) {
    console.warn(`Warning: could not refresh distro lifecycle data: ${message}`);
    console.warn(`Warning: keeping existing ${OUTPUT_FILE}`);
  } else {
    console.warn(`Warning: could not fetch distro lifecycle data: ${message}`);
    console.warn(`Warning: writing default lifecycle data from ${DEFAULT_CATALOG_FILE}`);
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    await writeFile(
      OUTPUT_FILE,
      formatGeneratedCatalog(await loadCatalogFile(DEFAULT_CATALOG_FILE), DEFAULT_CATALOG_FILE),
    );
    console.warn(`Warning: generated ${OUTPUT_FILE} from default data`);
  }
}
