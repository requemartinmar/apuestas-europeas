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
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
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
  const today = madridDate(now);
  const end = now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000;

  const fixtures = data
    .filter((match) => {
      const kickoff = new Date(match.fecha_utc);
      return Number.isFinite(kickoff.getTime()) &&
        kickoff.getTime() > now.getTime() &&
        kickoff.getTime() <= end &&
        madridDate(kickoff) !== today &&
        relationName(match.equipo_local).trim() &&
        relationName(match.equipo_visitante).trim();
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
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const lines = fixtures.map((match) => {
    const kickoff = new Date(match.fecha_utc);
    const competition = relationName(match.competicion) || "Competición";
    const home = relationName(match.equipo_local) || "Local";
    const away = relationName(match.equipo_visitante) || "Visitante";

    return "🏆 <b>" + esc(competition) + "</b> · " +
      esc(dateFmt.format(kickoff)) +
      "\n⚽ <b>" + esc(home) + " — " + esc(away) + "</b>";
  });

  const header = "📅 <b>PRÓXIMOS PARTIDOS · " + lookaheadDays +
    " DÍAS</b>\nCalendario verificado; sin probabilidades cuando no hay histórico suficiente.\n\n";
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? current + "\n\n" + line : line;
    if (header.length + candidate.length > maxMessageChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunk, index) => {
    const page = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
    return header.replace("</b>", page + "</b>") + chunk;
  });
}
