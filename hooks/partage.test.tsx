import { expect, mock, test } from 'claude-code/testing'

// Une mesure pour toutes les sessions : celle qui trouve la mesure rangée périmée relève le Mac et la range dans un
// fichier, les autres la reprennent. Ici, ce fichier est simulé, comme le relevé lui-même.
const OPTIONS = { options: { language: 'fr', sparkline: 'bars' } } as const
const MAISON = '/Users/quelqu-un'
const PARTAGE = `${MAISON}/Library/Caches/mac-sonde/releve.json`
const MAINTENANT = 1_800_000_000_000

// 10 cœurs, 64 Gio : seul le CPU change d'une mesure à l'autre.
const sortie = (cpu: number) => `68719476736
10
{ 3.44 3.19 3.44 }
total = 7168.00M  used = 5120.00M  free = 2048.00M  (encrypted)
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active:                                1900000.
Pages wired down:                             300000.
Pages occupied by compressor:                 400000.
iostat: ${cpu} 0 ${100 - cpu}  3.44 3.19 3.44
`

const bandeau = {
  plugin: 'mac-sonde',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 300,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// Le monde sous le mod : la maison, les fichiers (dont la mesure rangée), le relevé, qui rend chaque fois 40 % de CPU.
function monde(on: any, fichiers: Record<string, string>, maison: string | null = MAISON) {
  const horloge = mock.clock(on, { now: MAINTENANT })
  mock.store(on, {})
  const ecrits: { path: string; text: string }[] = []
  let releves = 0
  on('env.get', () => ({ value: maison ?? undefined }))
  on('fs.read', (_: unknown, e: any) => {
    if (e.path in fichiers) return { value: fichiers[e.path] }
    throw new Error('ENOENT')
  })
  on('fs.write', (_: unknown, e: any) => {
    fichiers[e.path] = e.text
    ecrits.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'mac' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => {
    releves++
    return { value: { exitCode: 0, stdout: sortie(40), stderr: '' } }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>moteur</Text>
  })
  return { horloge, ecrits, releves: () => releves }
}

const demarrer = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

async function ligne($: any) {
  const ui = await $.ui.mount(bandeau)
  const texte = (await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text ?? ''
  await ui.unmount()
  return texte
}

const pointsCpu = async ($: any) => ((await ligne($)).match(/CPU \d+ % ([▁-█]*)/)?.[1] ?? '').length

test('une mesure fraîche rangée par une autre session est reprise, sans relever le Mac', OPTIONS, async ($, on) => {
  const fichiers = { [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT - 2000, sortie: sortie(70) }) }
  const { releves } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(0)
  expect(await ligne($)).toContain('CPU 70 %')
})

test('mesure périmée : la session annonce son relevé, relève le Mac et range sa mesure pour les autres', OPTIONS, async ($, on) => {
  const fichiers = { [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT - 60_000, sortie: sortie(70) }) }
  const { releves, ecrits } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(1)
  expect(await ligne($)).toContain('CPU 40 %')
  expect(ecrits.map(e => e.path)).toEqual([PARTAGE, PARTAGE])
  expect(JSON.parse(ecrits[0]!.text)).toMatchObject({ enCoursDepuis: MAINTENANT })
  expect(JSON.parse(ecrits[1]!.text)).toEqual({ mesureA: MAINTENANT, sortie: sortie(40) })
})

test('aucune mesure rangée : la session relève le Mac et range sa mesure', OPTIONS, async ($, on) => {
  const fichiers: Record<string, string> = {}
  const { releves } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(1)
  expect(JSON.parse(fichiers[PARTAGE]!)).toEqual({ mesureA: MAINTENANT, sortie: sortie(40) })
})

test('une mesure rangée illisible compte comme absente', OPTIONS, async ($, on) => {
  const { releves } = monde(on, { [PARTAGE]: '{ pas du json' })
  await demarrer($)
  expect(releves()).toBe(1)
  expect(await ligne($)).toContain('CPU 40 %')
})

test('une autre session relève en ce moment : la session attend sa mesure au lieu de relever aussi', OPTIONS, async ($, on) => {
  const fichiers = {
    [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT - 60_000, sortie: sortie(70), enCoursDepuis: MAINTENANT - 500 }),
  }
  const { releves, horloge } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(0)
  expect(await ligne($)).toContain('pas de mesure')

  // L'autre session a fini : sa mesure, rangée 5 s plus tard, est fraîche au relevé suivant (10 s après).
  fichiers[PARTAGE] = JSON.stringify({ mesureA: MAINTENANT + 5000, sortie: sortie(55) })
  await horloge.advance(10_000)
  expect(releves()).toBe(0)
  expect(await ligne($)).toContain('CPU 55 %')
})

test('un relevé annoncé depuis plus de 3 s est tenu pour abandonné : la session relève elle-même', OPTIONS, async ($, on) => {
  const fichiers = {
    [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT - 60_000, sortie: sortie(70), enCoursDepuis: MAINTENANT - 5000 }),
  }
  const { releves } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(1)
})

test('pas de nouvelle mesure : la ligne ne change pas, aucun point n’est ajouté', OPTIONS, async ($, on) => {
  const fichiers = { [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT - 1000, sortie: sortie(70) }) }
  const { releves, horloge } = monde(on, fichiers)
  await demarrer($)
  // Une deuxième mesure, rangée par une autre session : le graphe a ses deux premiers points.
  fichiers[PARTAGE] = JSON.stringify({ mesureA: MAINTENANT + 9000, sortie: sortie(70) })
  await horloge.advance(10_000)
  expect(await pointsCpu($)).toBe(2)

  // Au relevé suivant, une autre session est en train de relever : rien de neuf à montrer.
  fichiers[PARTAGE] = JSON.stringify({ mesureA: MAINTENANT + 9000, sortie: sortie(70), enCoursDepuis: MAINTENANT + 19_500 })
  await horloge.advance(10_000)
  expect(releves()).toBe(0)
  expect(await pointsCpu($)).toBe(2)
})

test('une mesure datée dans le futur (horloge qui a reculé) est tenue pour périmée', OPTIONS, async ($, on) => {
  const fichiers = {
    [PARTAGE]: JSON.stringify({ mesureA: MAINTENANT + 60_000, sortie: sortie(70), enCoursDepuis: MAINTENANT + 60_000 }),
  }
  const { releves } = monde(on, fichiers)
  await demarrer($)
  expect(releves()).toBe(1)
  expect(JSON.parse(fichiers[PARTAGE]!)).toEqual({ mesureA: MAINTENANT, sortie: sortie(40) })
})

test('sans dossier personnel connu, chaque session relève le Mac elle-même, comme avant', OPTIONS, async ($, on) => {
  const { releves, ecrits } = monde(on, {}, null)
  await demarrer($)
  expect(releves()).toBe(1)
  expect(ecrits).toEqual([])
  expect(await ligne($)).toContain('CPU 40 %')
})
