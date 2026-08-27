const GITHUB_OWNER = "derdealbrudi";
const GITHUB_REPO = "dealbrudi-deals";
const GITHUB_FOLDER = "deals";

function authHeaders(env) {
  return {
    Authorization: `Bearer ${env.DEALBRUDI_TOKEN}`,
    Accept: "application/json"
  };
}

async function importDeal(env, deal) {
  const response = await fetch(env.DEALBRUDI_ENDPOINT, {
    method: "POST",
    headers: {
      ...authHeaders(env),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(deal)
  });

  if (response.ok) return "imported";
  if (response.status === 409) return "duplicate";

  throw new Error(
    `Deal-Import fehlgeschlagen: ${response.status} ${await response.text()}`
  );
}

async function processGithubDeals(env) {
  const listUrl =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FOLDER}`;

  const response = await fetch(listUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DealBrudi-Importer"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub-Liste nicht erreichbar: ${response.status}`);
  }

  const entries = await response.json();
  const files = entries.filter(
    (entry) =>
      entry.type === "file" &&
      entry.name.endsWith(".json") &&
      entry.download_url
  );

  const result = {
    found: files.length,
    imported: 0,
    duplicates: 0,
    failed: 0
  };

  for (const file of files) {
    try {
      const download = await fetch(file.download_url, {
        headers: { "User-Agent": "DealBrudi-Importer" }
      });

      if (!download.ok) {
        throw new Error(`GitHub-Download fehlgeschlagen: ${download.status}`);
      }

      const status = await importDeal(env, await download.json());
      if (status === "imported") result.imported++;
      if (status === "duplicate") result.duplicates++;
    } catch (error) {
      result.failed++;
      console.error(file.name, error);
    }
  }

  return result;
}

async function markSiteFile(env, url, status, error = "") {
  await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(env),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ status, error })
  });
}

async function processSiteFiles(env) {
  const origin = new URL(env.DEALBRUDI_ENDPOINT).origin;
  const listResponse = await fetch(`${origin}/api/import/files`, {
    headers: authHeaders(env)
  });

  if (!listResponse.ok) {
    throw new Error(`Dateiliste nicht erreichbar: ${listResponse.status}`);
  }

  const { files } = await listResponse.json();
  const result = {
    found: files.length,
    imported: 0,
    duplicates: 0,
    failed: 0
  };

  for (const file of files) {
    const statusUrl = `${origin}/api/import/files/${file.id}`;

    try {
      const downloadResponse = await fetch(file.downloadUrl, {
        headers: authHeaders(env)
      });

      if (!downloadResponse.ok) {
        throw new Error(
          `Download fehlgeschlagen: ${downloadResponse.status}`
        );
      }

      const status = await importDeal(env, await downloadResponse.json());
      await markSiteFile(env, statusUrl, "processed");

      if (status === "imported") result.imported++;
      if (status === "duplicate") result.duplicates++;
    } catch (error) {
      await markSiteFile(
        env,
        statusUrl,
        "failed",
        error instanceof Error ? error.message : "Unbekannter Fehler"
      );
      result.failed++;
    }
  }

  return result;
}

async function runImport(env) {
  const [github, site] = await Promise.all([
    processGithubDeals(env),
    processSiteFiles(env)
  ]);

  return { ok: true, github, site };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      if (
        request.headers.get("Authorization") !==
        `Bearer ${env.DEALBRUDI_TOKEN}`
      ) {
        return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
      }

      return Response.json(await runImport(env));
    }

    return Response.json({
      ok: true,
      message: "DealBrudi Importer läuft",
      source: `github.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_FOLDER}`
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runImport(env));
  }
};
