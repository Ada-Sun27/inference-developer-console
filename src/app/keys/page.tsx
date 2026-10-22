"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTime } from "../../lib/format";
import { gql } from "../../lib/gql";

type ApiKey = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Project = { id: string; name: string; apiKeys: ApiKey[] };

const KEY_FIELDS = "id name prefix createdAt lastUsedAt revokedAt";

export default function KeysPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");
  const [keyNames, setKeyNames] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await gql<{ projects: Project[] }>(`{ projects { id name apiKeys { ${KEY_FIELDS} } } }`);
      setProjects(d.projects);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const createProject = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await gql(`mutation($name: String!) { createProject(name: $name) { id } }`, { name: newProject });
      setNewProject("");
    });
  };

  const createKey = (projectId: string) => (e: React.FormEvent) => {
    e.preventDefault();
    const name = keyNames[projectId]?.trim() || "Default key";
    run(async () => {
      const d = await gql<{ createApiKey: { secret: string } }>(
        `mutation($projectId: ID!, $name: String!) { createApiKey(projectId: $projectId, name: $name) { secret } }`,
        { projectId, name },
      );
      setCreated({ name, secret: d.createApiKey.secret });
      setCopied(false);
      setKeyNames((k) => ({ ...k, [projectId]: "" }));
    });
  };

  const revoke = (key: ApiKey) => {
    if (!window.confirm(`Revoke "${key.name}"? Requests using it will be rejected immediately.`)) return;
    run(() => gql(`mutation($id: ID!) { revokeApiKey(id: $id) { id } }`, { id: key.id }));
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API keys</h1>
          <p className="lede">Each key belongs to one project. Usage and requests are attributed to the key’s project.</p>
        </div>
        <form className="inline-form" onSubmit={createProject}>
          <input type="text" aria-label="New project name" placeholder="New project name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
          <button type="submit" disabled={!newProject.trim()}>Create project</button>
        </form>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}

      {created && (
        <div className="secret" role="status">
          <p><strong>Copy “{created.name}” now.</strong> This is the only time the full key is shown. Only a hash is stored.</p>
          <code className="mono">{created.secret}</code>
          <div className="controls">
            <button type="button" className="primary" onClick={copy}>{copied ? "Copied" : "Copy key"}</button>
            <button type="button" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}

      {projects.length === 0 && !error && <div className="notice">Create a project to issue your first API key.</div>}

      {projects.map((project) => (
        <section className="project" key={project.id}>
          <div className="project-head">
            <h2>{project.name}</h2>
            <form className="inline-form" onSubmit={createKey(project.id)}>
              <input
                type="text"
                aria-label={`Key name for ${project.name}`}
                placeholder="Key name"
                value={keyNames[project.id] ?? ""}
                onChange={(e) => setKeyNames((k) => ({ ...k, [project.id]: e.target.value }))}
              />
              <button type="submit" className="primary">Create key</button>
            </form>
          </div>
          {project.apiKeys.length === 0 ? (
            <p className="muted">No keys yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {project.apiKeys.map((key) => (
                    <tr key={key.id}>
                      <td>{key.name}</td>
                      <td className="mono">{key.prefix}…</td>
                      <td>{formatTime(key.createdAt)}</td>
                      <td>{key.lastUsedAt ? formatTime(key.lastUsedAt) : <span className="muted">Never</span>}</td>
                      <td>{key.revokedAt ? <span className="muted">Revoked</span> : "Active"}</td>
                      <td className="num">
                        {!key.revokedAt && <button type="button" className="danger" onClick={() => revoke(key)}>Revoke</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
