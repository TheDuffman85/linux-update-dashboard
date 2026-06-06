import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const host = "127.0.0.1";
const port = 4873;
const tarballDir = "/opt/ludash-fixtures/npm/tarballs";

const packages = new Map([
  ["ludash-npm-global-fixture", {
    fileBase: "ludash-npm-global-fixture",
    versions: ["1.0.0", "1.1.0"],
  }],
  ["@ludash/npm-project-fixture", {
    fileBase: "ludash-npm-project-fixture",
    versions: ["1.0.0", "1.1.0"],
  }],
]);

function metadataFor(name, spec) {
  const versions = Object.fromEntries(spec.versions.map((version) => {
    const file = `${spec.fileBase}-${version}.tgz`;
    return [version, {
      name,
      version,
      dist: {
        tarball: `http://${host}:${port}/tarballs/${file}`,
      },
    }];
  }));

  return {
    name,
    "dist-tags": {
      latest: spec.versions.at(-1),
    },
    versions,
  };
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const pathname = decodeURIComponent(url.pathname.slice(1));

  if (pathname.startsWith("tarballs/")) {
    const file = basename(pathname.slice("tarballs/".length));
    const path = join(tarballDir, file);
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end("missing tarball");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    createReadStream(path).pipe(res);
    return;
  }

  const spec = packages.get(pathname);
  if (!spec) {
    res.writeHead(404);
    res.end("missing package");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(metadataFor(pathname, spec)));
}).listen(port, host);
