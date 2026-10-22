"use client";

import { useEffect, useState } from "react";
import { gql } from "../lib/gql";

export type ProjectOption = { id: string; name: string };

export function useProjects() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  useEffect(() => {
    gql<{ projects: ProjectOption[] }>(`{ projects { id name } }`)
      .then((d) => setProjects(d.projects))
      .catch(() => setProjects([]));
  }, []);
  return projects;
}
