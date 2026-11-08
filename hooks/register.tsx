import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Historique, Lecture } from '../types'

const PERIODE_MS = 3000
const PERIME_S = 60
const OCTETS_PAR_GO = 1024 ** 3
const MO_PAR_GO = 1024
const CLE_MASQUE = 'masque'
// Les textes affichés, par langue (option `language` du manifeste ; l'anglais par défaut).
const TEXTES = {
  en: {
    nom: 'This Mac',
    description: 'Show or hide the Mac CPU, GPU, RAM and temperature line',
    sansMesure: ': no reading · /mac to hide',
    masquee: 'This Mac line hidden. Type /mac to show it again.',
    affichee: 'This Mac line shown.',
    charge: 'load',
    go: 'GiB',
    decimale: '.',
  },
  fr: {
    nom: 'Ce Mac',
    description: 'Affiche ou masque la ligne CPU, GPU, RAM et température du Mac',
    sansMesure: ' : pas de mesure · /mac pour masquer',
    masquee: 'Ligne Ce Mac masquée. /mac pour la réafficher.',
    affichee: 'Ligne Ce Mac affichée.',
    charge: 'charge',
    go: 'Gio',
    decimale: ',',
  },
} as const
const SEUIL_CHARGE = 70
const SEUIL_SATURE = 90
const SEUIL_CHAUD = 85
const SEUIL_BRULANT = 95
// Un seul appel : RAM totale, cœurs, charge, échange, pages mémoire, le GPU (une ligne, absente si ioreg ne répond pas),
// puis le CPU de chaque processus : cette liste reste en dernier, `analyser` la somme jusqu'à la fin.
const RELEVE = [
  '/bin/sh',
  '-c',
  `sysctl -n hw.memsize hw.ncpu vm.loadavg vm.swapusage; vm_stat; ioreg -r -d 1 -w0 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*'; ps -A -o %cpu`,
]

const sortie = atom({ plugin: 'mac-sonde', key: 'sortie' } as const, null)
const temperature = atom({ plugin: 'mac-sonde', key: 'temperature' } as const, { ligne: null, lueA: 0 })
const masque = atom({ plugin: 'mac-sonde', key: 'masque' } as const, false)
// `historique-2` : la RAM et la température rejoignent le CPU et la charge ; un historique plus ancien repart de zéro.
const historique = atom(
  { plugin: 'mac-sonde', key: 'historique' } as const,
  { cpu: [], charge: [], ram: [], temp: [] },
  { shape: 'historique-2' },
)

// Un mini-graphe derrière chaque valeur : 10 relevés (30 s) au plus, un caractère par relevé.
// Faute de place, les graphes raccourcissent ensemble jusqu'à 5 points, puis partent un à un par priorité.
const POINTS_MAX = 10
const POINTS_REDUITS = 5
const POINTS_MIN = 2
const PRIORITE = ['cpu', 'charge', 'temp', 'ram'] as const
type Cle = (typeof PRIORITE)[number]
const BLOCS = '▁▂▃▄▅▆▇█'
const garder = <T,>(serie: T[], valeur: T) => [...serie, valeur].slice(-POINTS_MAX)
// Hauteur : de 0 à 100 % ; la température de 30 °C (▁) à 100 °C (█).
const cran = (part: number) => BLOCS.charAt(Math.min(BLOCS.length - 1, Math.max(0, Math.floor(part * BLOCS.length))))
const hauteur = (cle: Cle, v: number) => (cle === 'temp' ? cran((v - 30) / 70) : cran(v / 100))
// Couleur : les seuils de la pastille, de charge pour les taux, de chaleur pour la température.
function couleur(cle: Cle, v: number) {
  const [orange, rouge] = cle === 'temp' ? [SEUIL_CHAUD, SEUIL_BRULANT] : [SEUIL_CHARGE, SEUIL_SATURE]
  return v >= rouge ? 'error' : v >= orange ? 'warning' : 'success'
}

// Combien de graphes, et de combien de points, tiennent dans la place restante : chacun prend une espace et ses points.
function disposer(cles: readonly Cle[], releves: number, place: number) {
  if (releves < POINTS_MIN) return { cles: [], points: 0 }
  for (let nombre = cles.length; nombre > 0; nombre--) {
    for (let longueur = POINTS_MAX; longueur >= POINTS_REDUITS; longueur--) {
      const points = Math.min(longueur, releves)
      if (nombre * (1 + points) <= place) return { cles: cles.slice(0, nombre), points }
    }
  }
  return { cles: [], points: 0 }
}

const chiffre = (texte: string, motif: RegExp) => Number(texte.match(motif)?.[1] ?? NaN)

function analyser(texte: string | null) {
  if (!texte) return null

  const lignes = texte.split('\n')
  const entete = lignes.findIndex(l => l.trim() === '%CPU')
  const ramTotale = Number(lignes[0])
  const coeurs = Number(lignes[1])
  const page = chiffre(texte, /page size of (\d+) bytes/)
  const pages = (nom: string) => chiffre(texte, new RegExp(`${nom}:\\s+(\\d+)\\.`))
  // Comme le Moniteur d'activité : mémoire des apps, mémoire câblée et mémoire compressée, sans le cache.
  const ramUtilisee =
    (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page
  const cpu = lignes.slice(entete + 1).reduce((somme, l) => somme + Number(l || 0), 0) / coeurs
  const echangeGo = chiffre(texte, /used = ([\d.]+)M/) / MO_PAR_GO
  const charge = chiffre(texte, /\{ ([\d.]+) /)

  // Le GPU est facultatif : sans lecture (NaN), la ligne s'affiche sans lui au lieu de perdre toute mesure.
  const gpu = chiffre(texte, /"Device Utilization %"=(\d+)/)

  const mesure = { cpu, ramTotale, ramUtilisee, echangeGo, charge, coeurs }
  return entete > 0 && Object.values(mesure).every(Number.isFinite) ? { ...mesure, gpu } : null
}

// Format du relais : date (s) · température (°C). Absente ou trop ancienne, elle n'est simplement pas affichée.
function degres({ ligne, lueA }: Lecture) {
  const v = (ligne ?? '').trim().split(/\s+/).map(Number)
  if (v.length !== 2 || v.some(n => !Number.isFinite(n))) return null
  const [date = NaN, valeur = NaN] = v
  return lueA / 1000 - date <= PERIME_S ? valeur : null
}

function couleurEtat(temperature: number | null, ...taux: number[]) {
  const pire = Math.max(...taux)
  const chaleur = temperature ?? 0
  if (pire >= SEUIL_SATURE || chaleur >= SEUIL_BRULANT) return 'error'
  return pire >= SEUIL_CHARGE || chaleur >= SEUIL_CHAUD ? 'warning' : 'success'
}

export const register: Register = (on, options) => {
  const t = options.language === 'fr' ? TEXTES.fr : TEXTES.en
  const NOM = t.nom
  const virgule = (n: number) => n.toFixed(1).replace('.', t.decimale)
  // La température est facultative : sans fichier réglé (option `temperatureFile`), elle n'est jamais lue.
  const fichierTemperature = typeof options.temperatureFile === 'string' ? options.temperatureFile.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mac', description: t.description })
    const chemin = fichierTemperature.startsWith('~/')
      ? `${(await $.env.get('HOME')) ?? ''}${fichierTemperature.slice(1)}`
      : fichierTemperature
    const relever = async () => {
      const { stdout } = await $.process.run(RELEVE).catch(() => ({ stdout: null }))
      const ligne = chemin ? await $.fs.read(chemin).catch(() => null) : null
      const lueA = await $.clock.now()
      const m = analyser(stdout)
      if (m) {
        const point = {
          cpu: m.cpu,
          charge: (m.charge / m.coeurs) * 100,
          ram: (m.ramUtilisee / m.ramTotale) * 100,
          temp: degres({ ligne, lueA }),
        }
        await update($, historique, passe => ({
          cpu: garder(passe.cpu, point.cpu),
          charge: garder(passe.charge, point.charge),
          ram: garder(passe.ram, point.ram),
          temp: garder(passe.temp, point.temp),
        }))
      }
      await update($, sortie, () => stdout)
      await update($, temperature, () => ({ ligne, lueA }))
    }
    const estMasque = (await $.store.get(CLE_MASQUE).catch(() => false)) === true
    await update($, masque, () => estMasque)
    // Chaque session (et chaque rechargement du mod) repart d'un graphe vide : jamais de vieux points d'avant.
    await update($, historique, () => ({ cpu: [], charge: [], ram: [], temp: [] }))
    $.clock.every(PERIODE_MS, () => void relever())
    await relever()

    return next(e)
  })

  on('command.run', { command: 'mac' }, async $ => {
    const estMasque = !(await read($, masque))
    await update($, masque, () => estMasque)
    await $.store.set(CLE_MASQUE, estMasque)

    return { text: estMasque ? t.masquee : t.affichee }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, masque))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const m = analyser(await read($, sortie))
    const chaleur = degres(await read($, temperature))
    const autresLignes = await next(e)

    // Une ligne nue, sans cadre ni marge, coupée en bout plutôt que repliée : le bandeau tient toujours sur une rangée.
    const barre = (couleurPastille: string, ...suite: RenderChildren[]) => (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          <Text color={couleurPastille}>● </Text>
          <Text weight="medium">{NOM}</Text>
          {suite}
        </Text>
        {autresLignes}
      </Box>
    )

    if (!m) return barre('inactive', t.sansMesure)

    const textes: Record<Cle, string> = {
      cpu: ` · CPU ${Math.round(m.cpu)} %`,
      ram: ` · RAM ${virgule(m.ramUtilisee / OCTETS_PAR_GO)} ${t.go}`,
      temp: chaleur === null ? '' : ` · ${chaleur} °C`,
      // La charge (moyenne sur 1 min) est rapportée aux cœurs : 100 % = tous pris, au-delà = des tâches attendent.
      charge: ` · ${t.charge} ${Math.round((m.charge / m.coeurs) * 100)} %`,
    }
    const gpu = Number.isFinite(m.gpu) ? ` · GPU ${Math.round(m.gpu)} %` : ''
    const swap = ` · swap ${virgule(m.echangeGo)} ${t.go}`

    // Le swap part quand la ligne de chiffres ne tient plus ; les graphes partent avant lui et prennent la place qui reste.
    const chiffres = `● ${NOM}${textes.cpu}${gpu}${textes.ram}${textes.temp}${textes.charge}`
    const tient = `${chiffres}${swap}`.length <= e.props.bodyColumns
    // Jamais `h` : c'est la fabrique des éléments JSX.
    const passe: Historique = await read($, historique)
    const traces = PRIORITE.filter(cle => cle !== 'temp' || chaleur !== null)
    const { cles, points } = tient
      ? disposer(traces, passe.cpu.length, e.props.bodyColumns - `${chiffres}${swap}`.length)
      : { cles: [], points: 0 }

    // Les graphes en chasse fixe : le desktop compte la place en cellules à chasse fixe, mais écrit en proportionnelle.
    // Une barre manquante (température non lue à ce relevé) reste une espace, pour garder les graphes alignés dans le temps.
    const graphe = (cle: Cle) =>
      cles.includes(cle) && (
        <Text mono>
          {' '}
          {passe[cle].slice(-points).map(v => (v === null ? ' ' : <Text color={couleur(cle, v)}>{hauteur(cle, v)}</Text>))}
        </Text>
      )

    return barre(
      couleurEtat(chaleur, m.cpu, (m.ramUtilisee / m.ramTotale) * 100, ...(Number.isFinite(m.gpu) ? [m.gpu] : [])),
      textes.cpu,
      graphe('cpu'),
      gpu,
      textes.ram,
      graphe('ram'),
      textes.temp,
      textes.temp && graphe('temp'),
      textes.charge,
      graphe('charge'),
      tient ? swap : '',
    )
  })
}
