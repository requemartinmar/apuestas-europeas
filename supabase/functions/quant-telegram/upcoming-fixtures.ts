export interface UpcomingFixture {
  fecha_utc: string;
  equipo_local?: { nombre?: string };
  equipo_visitante?: { nombre?: string };
  competicion?: { nombre?: string };
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

export function formatUpcomingFixtures(
  data: UpcomingFixture[],
  now: Date,
  lookaheadDays = 21,
  limit = 20,
): string {
  const today = madridDate(now);
  const end = now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000;

  const fixtures = data
    .filter((match) => {
      const kickoff = new Date(match.fecha_utc);
      return Number.isFinite(kickoff.getTime()) &&
        kickoff.getTime() > now.getTime() &&
        kickoff.getTime() <= end &&
        madridDate(kickoff) !== today &&
        String(match.equipo_local?.nombre ?? "").trim() &&
        String(match.equipo_visitante?.nombre ?? "").trim();
    })
    .sort((a, b) =>
      new Date(a.fecha_utc).getTime() - new Date(b.fecha_utc).getTime()
    )
    .slice(0, limit);

  if (!fixtures.length) {
    return `📅 No hay próximos partidos registrados en el calendario durante los siguientes ${lookaheadDays} días.`;
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
    const competition = String(match.competicion?.nombre ?? "Competición");
    const home = String(match.equipo_local?.nombre ?? "Local");
    const away = String(match.equipo_visitante?.nombre ?? "Visitante");

    return "🏆 <b>" + esc(competition) + "</b> · " +
      esc(dateFmt.format(kickoff)) +
      "\n⚽ <b>" + esc(home) + " — " + esc(away) + "</b>";
  });

  return "📅 <b>PRÓXIMOS PARTIDOS · " + lookaheadDays +
    " DÍAS</b>\nCalendario verificado; sin probabilidades cuando no hay histórico suficiente.\n\n" +
    lines.join("\n\n");
}
