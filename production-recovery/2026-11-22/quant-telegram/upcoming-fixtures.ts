type RelatedName = { nombre?: string } | { nombre?: string }[];

export interface UpcomingFixture {
  fecha_utc: string;
  equipo_local?: RelatedName;
  equipo_visitante?: RelatedName;
  competicion?: RelatedName;
}

function relationName(value?: RelatedName): string {
  const relation = Array.isArray(value) ? value[0] : value;
  return String(relation?.nombre ?? "");
}

function madridDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function madridDayNumber(date: Date): number {
  const [year, month, day] = madridDate(date).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatUpcomingFixturesMessages(
  data: UpcomingFixture[],
  now: Date,
  lookaheadDays = 21,
  maxMessageChars = 3500,
): string[] {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("La fecha de referencia del calendario no es válida");
  }

  const today = madridDayNumber(now);
  const lastDay = today + lookaheadDays;

  const fixtures = data
    .filter((match) => {
      const kickoff = new Date(match.fecha_utc);
      const kickoffTime = kickoff.getTime();

      if (!Number.isFinite(kickoffTime)) return false;

      const kickoffDay = madridDayNumber(kickoff);

      return kickoffTime > now.getTime() &&
        kickoffDay > today &&
        kickoffDay <= lastDay &&
        Boolean(relationName(match.equipo_local).trim()) &&
        Boolean(relationName(match.equipo_visitante).trim());
    })
    .sort((a, b) =>
      new Date(a.fecha_utc).getTime() - new Date(b.fecha_utc).getTime()
    );

  if (!fixtures.length) {
    return [
      `📅 No hay próximos partidos registrados en el calendario durante los siguientes ${lookaheadDays} días.`,
    ];
  }

  const dateFmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  });

  const timeFmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  // Agrupar primero por competición y después por fecha de Madrid.
  const competitions = new Map<
    string,
    Map<string, { kickoff: number; lines: string[] }>
  >();

  for (const match of fixtures) {
    const kickoff = new Date(match.fecha_utc);
    const competition = relationName(match.competicion).trim() ||
      "Competición";
    const dateKey = madridDate(kickoff);
    const kickoffTime = kickoff.getTime();

    if (!competitions.has(competition)) {
      competitions.set(competition, new Map());
    }

    const dates = competitions.get(competition)!;

    if (!dates.has(dateKey)) {
      dates.set(dateKey, { kickoff: kickoffTime, lines: [] });
    }

    const home = relationName(match.equipo_local) || "Local";
    const away = relationName(match.equipo_visitante) || "Visitante";

    dates.get(dateKey)!.lines.push(
      "🕒 <b>" + esc(timeFmt.format(kickoff)) + "</b> · ⚽ <b>" +
        esc(home) + " — " + esc(away) + "</b>",
    );
  }

  // Las competiciones se ordenan por su próximo partido.
  const orderedCompetitions = [...competitions.entries()].sort(
    (a, b) => {
      const firstA = Math.min(...[...a[1].values()].map((v) => v.kickoff));
      const firstB = Math.min(...[...b[1].values()].map((v) => v.kickoff));
      return firstA - firstB || a[0].localeCompare(b[0], "es");
    },
  );

  const sections: { heading: string; matches: string[] }[] = [];

  for (const [competition, dates] of orderedCompetitions) {
    const orderedDates = [...dates.entries()].sort(
      (a, b) => a[1].kickoff - b[1].kickoff,
    );

    for (const [, group] of orderedDates) {
      const dateLabel = dateFmt.format(new Date(group.kickoff));
      sections.push({
        heading:
          "🏆 <b>" + esc(competition) + "</b>\n" +
          "📅 <b>" + esc(dateLabel.toLocaleUpperCase("es-ES")) + "</b>",
        matches: group.lines,
      });
    }
  }

  const header =
    "📅 <b>PRÓXIMOS PARTIDOS · " + lookaheadDays +
    " DÍAS</b>\nCalendario verificado; sin probabilidades cuando no hay histórico suficiente.\n\n";

  const chunks: string[] = [];
  let current = "";

  // Reservar espacio para la numeración de páginas de Telegram.
  const paginationReserve = 16;
  const maxBodyChars = maxMessageChars - header.length - paginationReserve;

  if (maxBodyChars <= 0) {
    throw new RangeError("El límite de mensaje es demasiado pequeño");
  }

  for (const section of sections) {
    let sectionStarted = false;

    for (const matchLine of section.matches) {
      const prefix = sectionStarted ? "" : section.heading + "\n";
      const separator = current ? "\n\n" : "";
      const candidate = current + separator + prefix + matchLine;

      if (candidate.length > maxBodyChars && current) {
        chunks.push(current);
        current = section.heading + "\n" + matchLine;
      } else {
        current = candidate;
      }

      if (current.length > maxBodyChars) {
        throw new RangeError(
          "Un partido o encabezado supera el límite de mensaje configurado",
        );
      }

      sectionStarted = true;
    }
  }

  if (current) chunks.push(current);

  return chunks.map((chunk, index) => {
    const page = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
    return header.replace("</b>", page + "</b>") + chunk;
  });
}

