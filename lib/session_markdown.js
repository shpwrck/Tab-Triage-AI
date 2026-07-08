export function sessionToMarkdown(session) {
  const source = session && typeof session === "object" ? session : {};
  const title = String(source.title || "Saved session").trim() || "Saved session";
  const createdAt = formatSessionDate(source.createdAt);
  let out = `# ${title}\n\n_${createdAt}_\n\n`;

  for (const group of sessionGroups(source.groups)) {
    out += `## ${group.label}\n\n`;
    for (const line of summaryLines(group.summary)) out += `- ${line}\n`;
    out += `\n`;
    for (const tab of sessionTabs(group.tabs)) {
      out += `- [${tab.title}](${tab.url})\n`;
    }
    out += `\n`;
  }

  return out;
}

function formatSessionDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString()
    : "Unknown date";
}

function sessionGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map(group => {
    const source = group && typeof group === "object" ? group : {};
    return {
      label: String(source.label || "Saved tabs").trim() || "Saved tabs",
      summary: source.summary,
      tabs: source.tabs,
    };
  });
}

function summaryLines(summary) {
  if (!Array.isArray(summary)) return [];
  return summary.map(line => String(line || "").trim()).filter(Boolean);
}

function sessionTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .map(tab => {
      const source = tab && typeof tab === "object" ? tab : {};
      const url = String(source.url || "").trim();
      if (!url) return null;
      return {
        title: String(source.title || url),
        url,
      };
    })
    .filter(Boolean);
}
