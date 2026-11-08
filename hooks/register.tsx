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
    description: 'Show or hide the Mac CPU, GPU, RAM and temperature line; bars, line or filled: sparkline style',
    indice: '[bars|line|filled]',
    sansMesure: ': no reading · /mac to hide',
    masquee: 'This Mac line hidden. Type /mac to show it again.',
    affichee: 'This Mac line shown.',
    style: (nom: string) => `Sparklines now in ${nom} style.`,
    inconnu: (mot: string) => `Unknown style: "${mot}".`,
    aide: 'Sparkline styles: /mac bars (▁▃▅█), /mac line (⣀⡠⠊), /mac filled (⣀⣤⣶⣿). /mac alone hides or shows the line.',
    charge: 'load',
    go: 'GiB',
    decimale: '.',
  },
  fr: {
    nom: 'Ce Mac',
    description: 'Affiche ou masque la ligne CPU, GPU, RAM et température du Mac ; barres, courbe ou pleine : style des graphes',
    indice: '[barres|courbe|pleine]',
    sansMesure: ' : pas de mesure · /mac pour masquer',
    masquee: 'Ligne Ce Mac masquée. /mac pour la réafficher.',
    affichee: 'Ligne Ce Mac affichée.',
    style: (nom: string) => `Graphes en style ${nom}.`,
    inconnu: (mot: string) => `Style inconnu : « ${mot} ».`,
    aide: 'Styles des graphes : /mac barres (▁▃▅█), /mac courbe (⣀⡠⠊), /mac pleine (⣀⣤⣶⣿). /mac seul masque ou affiche la ligne.',
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
const style = atom({ plugin: 'mac-sonde', key: 'style' } as const, 'barres')

// Un mini-graphe derrière chaque valeur, de 10 caractères au plus.
// Faute de place, les graphes raccourcissent ensemble jusqu'à 5 caractères, puis partent un à un par priorité.
const CARACTERES_MAX = 10
const CARACTERES_REDUITS = 5
const RELEVES_MIN = 2
const PRIORITE = ['cpu', 'charge', 'temp', 'ram'] as const
type Cle = (typeof PRIORITE)[number]

// Trois styles, choisis à l'installation (option `graphe`) puis avec `/mac barres|courbe|pleine` :
// - barres : ▁▂▃…█, un relevé par caractère, 8 hauteurs (10 relevés, 30 s) ;
// - courbe : le trait en points braille, deux relevés par caractère, 4 hauteurs (20 relevés, 1 min) ;
// - pleine : la même courbe, l'aire dessous remplie.
const STYLES = ['barres', 'courbe', 'pleine'] as const
type Style = (typeof STYLES)[number]
const CLE_STYLE = 'graphe'
const estStyle = (v: unknown): v is Style => STYLES.includes(v as Style)
// Les noms anglais des styles, acceptés par /mac et par l'option d'installation quelle que soit la langue.
const NOMS_EN: Record<Style, string> = { barres: 'bars', courbe: 'line', pleine: 'filled' }
const versStyle = (mot: unknown): Style | null =>
  estStyle(mot) ? mot : (STYLES.find(s => NOMS_EN[s] === mot) ?? null)
const parCaractere = (style: Style) => (style === 'barres' ? 1 : 2)
const RELEVES_MAX = CARACTERES_MAX * 2
const garder = <T,>(serie: T[], valeur: T) => [...serie, valeur].slice(-RELEVES_MAX)

// Part de la hauteur, de 0 à 1 : de 0 à 100 % ; la température de 30 °C à 100 °C.
const part = (cle: Cle, v: number) => Math.min(1, Math.max(0, cle === 'temp' ? (v - 30) / 70 : v / 100))
const BLOCS = '▁▂▃▄▅▆▇█'
const bloc = (p: number) => BLOCS.charAt(Math.min(BLOCS.length - 1, Math.floor(p * BLOCS.length)))
// Points braille d'un caractère, du bas vers le haut : colonne de gauche, puis de droite.
const POINTS_GAUCHE = [0x40, 0x04, 0x02, 0x01]
const POINTS_DROITE = [0x80, 0x20, 0x10, 0x08]
const rang = (p: number) => Math.min(POINTS_GAUCHE.length - 1, Math.floor(p * POINTS_GAUCHE.length))

// Les caractères d'une courbe : deux relevés chacun, le plus récent à droite ; un relevé manquant n'a pas de point.
// `pleine` remplit du bas jusqu'au relevé ; `courbe` relie chaque relevé au précédent par un trait vertical.
function courbe(valeurs: (number | null)[], versPart: (v: number) => number, pleine: boolean) {
  const releves = valeurs.length % 2 ? [null, ...valeurs] : valeurs
  const caracteres: { glyphe: string; releves: (number | null)[] }[] = []
  let precedent: number | null = null
  for (let i = 0; i < releves.length; i += 2) {
    let code = 0x2800
    const paire = [releves[i] ?? null, releves[i + 1] ?? null]
    paire.forEach((v, colonne) => {
      const points = colonne ? POINTS_DROITE : POINTS_GAUCHE
      if (v === null) {
        precedent = null
        return
      }
      const r = rang(versPart(v))
      const [bas, haut] = pleine ? [0, r] : [Math.min(precedent ?? r, r), Math.max(precedent ?? r, r)]
      for (let y = bas; y <= haut; y++) code |= points[y] ?? 0
      precedent = r
    })
    caracteres.push({ glyphe: String.fromCharCode(code), releves: paire })
  }
  return caracteres
}

// Couleur : les seuils de la pastille, de charge pour les taux, de chaleur pour la température.
function couleur(cle: Cle, v: number) {
  const [orange, rouge] = cle === 'temp' ? [SEUIL_CHAUD, SEUIL_BRULANT] : [SEUIL_CHARGE, SEUIL_SATURE]
  return v >= rouge ? 'error' : v >= orange ? 'warning' : 'success'
}

// Combien de graphes, et de combien de caractères, tiennent dans la place restante : chacun prend une espace et
// ses caractères ; un caractère porte `par` relevés.
function disposer(cles: readonly Cle[], releves: number, par: number, place: number) {
  if (releves < RELEVES_MIN) return { cles: [], caracteres: 0 }
  for (let nombre = cles.length; nombre > 0; nombre--) {
    for (let longueur = CARACTERES_MAX; longueur >= CARACTERES_REDUITS; longueur--) {
      const caracteres = Math.min(longueur, Math.ceil(releves / par))
      if (nombre * (1 + caracteres) <= place) return { cles: cles.slice(0, nombre), caracteres }
    }
  }
  return { cles: [], caracteres: 0 }
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
  const nomDuStyle = (s: Style) => (options.language === 'fr' ? s : NOMS_EN[s])
  // Le style choisi à l'installation (option `sparkline` : bars, line ou filled).
  const styleInstalle: Style = versStyle(options.sparkline) ?? 'barres'
  // La température est facultative : sans fichier réglé (option `temperatureFile`), elle n'est jamais lue.
  const fichierTemperature = typeof options.temperatureFile === 'string' ? options.temperatureFile.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mac', description: t.description, argumentHint: t.indice })
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
    // Le style choisi par /mac passe avant celui de l'installation.
    const styleRetenu = await $.store.get(CLE_STYLE).catch(() => null)
    await update($, style, () => versStyle(styleRetenu) ?? styleInstalle)
    // Chaque session (et chaque rechargement du mod) repart d'un graphe vide : jamais de vieux points d'avant.
    await update($, historique, () => ({ cpu: [], charge: [], ram: [], temp: [] }))
    $.clock.every(PERIODE_MS, () => void relever())
    await relever()

    return next(e)
  })

  on('command.run', { command: 'mac' }, async ($, e) => {
    const demande = e.args.trim().toLowerCase()
    const voulu = versStyle(demande)
    if (voulu) {
      await update($, style, () => voulu)
      await $.store.set(CLE_STYLE, voulu)
      return { text: t.style(nomDuStyle(voulu)) }
    }
    if (demande) return { text: `${t.inconnu(demande)} ${t.aide}` }

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
    const choisi: Style = await read($, style)
    const par = parCaractere(choisi)
    const traces = PRIORITE.filter(cle => cle !== 'temp' || chaleur !== null)
    const { cles, caracteres } = tient
      ? disposer(traces, passe.cpu.length, par, e.props.bodyColumns - `${chiffres}${swap}`.length)
      : { cles: [], caracteres: 0 }

    // Un caractère coloré au pire de ses relevés ; sans relevé (température non lue), une espace, pour garder les
    // graphes alignés dans le temps.
    const teinte = (cle: Cle, releves: (number | null)[], glyphe: string) => {
      const lus = releves.filter((v): v is number => v !== null)
      return lus.length ? <Text color={couleur(cle, Math.max(...lus))}>{glyphe}</Text> : ' '
    }
    const caracteresDe = (cle: Cle) => {
      const serie = passe[cle].slice(-caracteres * par)
      if (choisi === 'barres') return serie.map(v => teinte(cle, [v], v === null ? ' ' : bloc(part(cle, v))))
      return courbe(serie, v => part(cle, v), choisi === 'pleine').map(({ glyphe, releves }) => teinte(cle, releves, glyphe))
    }

    // Les graphes en chasse fixe : le desktop compte la place en cellules à chasse fixe, mais écrit en proportionnelle.
    const graphe = (cle: Cle) =>
      cles.includes(cle) && (
        <Text mono>
          {' '}
          {caracteresDe(cle)}
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
