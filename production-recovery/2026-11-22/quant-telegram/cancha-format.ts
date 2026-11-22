export interface CanchaDisplayEntry {
  competition: string;
  kickoff: string;
  content: string;
}

function madridDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatCanchaMessages(
  entries: CanchaDisplayEntry[],
  maxMessageChars = 3500,
): string[] {
  if (!Number.isInteger(maxMessageChars) || maxMessageChars < 500) {
    throw new RangeError("Límite de mensaje CANCHA no válido");
  }

  const valid = entries.map((entry) => ({
    ...entry,
    time: new Date(entry.kickoff),
  })).filter((entry) =>
    Number.isFinite(entry.time.getTime()) &&
    Boolean(entry.competition.trim()) &&
    Boolean(entry.content.trim())
  );

  if (!valid.length) return [];

  const timeFmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const dateFmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

  const competitions = new Map<string, Map<string, {
    kickoff: number;
    entries: typeof valid;
  }>>();

  for (const entry of valid) {
    const dateKey = madridDate(entry.time);

    if (!competitions.has(entry.competition)) {
      competitions.set(entry.competition, new Map());
    }

    const dates = competitions.get(entry.competition)!;

    if (!dates.has(dateKey)) {
      dates.set(dateKey, { kickoff: entry.time.getTime(), entries: [] });
    }

    dates.get(dateKey)!.entries.push(entry);
  }

  const ordered = [...competitions.entries()].sort((a, b) => {
    const firstA = Math.min(...[...a[1].values()].map((x) => x.kickoff));
    const firstB = Math.min(...[...b[1].values()].map((x) => x.kickoff));
    return firstA - firstB || a[0].localeCompare(b[0], "es");
  });

  const sections: { heading: string; matches: string[] }[] = [];

  for (const [competition, dates] of ordered) {
    const orderedDates = [...dates.values()].sort(
      (a, b) => a.kickoff - b.kickoff,
    );

    for (const group of orderedDates) {
      group.entries.sort((a, b) => a.time.getTime() - b.time.getTime());

      const heading =
        "🏆 <b>" + escapeHtml(competition) + "</b>\n" +
        "📅 <b>" +
        dateFmt.format(group.entries[0].time).toLocaleUpperCase("es-ES") +
        "</b>";

      sections.push({
        heading,
        matches: group.entries.map((entry) =>
          "🕒 <b>" + timeFmt.format(entry.time) + "</b>\n" + entry.content
        ),
      });
    }
  }

  const header = "⚽ <b>CANCHA · PRÓXIMOS PARTIDOS</b>\n\n";
  const footer =
    "\n\n<i>Datos históricos y estimaciones orientativas; no son garantías ni recomendaciones de apuesta.</i>";
  const reserve = 20;
  const limit = maxMessageChars - header.length - footer.length - reserve;

  if (limit <= 0) {
    throw new RangeError("Límite de mensaje CANCHA demasiado pequeño");
  }

  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    let firstInSection = true;

    for (const match of section.matches) {
      const prefix = firstInSection ? section.heading + "\n" : "";
      const candidate = current
        ? current + "\n\n" + prefix + match
        : section.heading + "\n" + match;

      if (candidate.length > limit && current) {
        chunks.push(current);
        current = section.heading + "\n" + match;
      } else {
        current = candidate;
      }

      if (current.length > limit) {
        throw new RangeError("Un partido CANCHA supera el límite de mensaje");
      }

      firstInSection = false;
    }
  }

  if (current) chunks.push(current);

  return chunks.map((chunk, index) => {
    const page = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
    return header.replace("</b>", page + "</b>") + chunk + footer;
  });
}
