export type Sortie = string | null
export type Lecture = { ligne: string | null; lueA: number }
/**
 * Les derniers relevés, du plus ancien au plus récent : CPU moyen des cœurs, charge rapportée aux cœurs et part de RAM
 * utilisée (en %), température (°C, `null` quand elle n'était pas lue à ce relevé).
 */
export type Historique = { cpu: number[]; charge: number[]; ram: number[]; temp: (number | null)[] }
/** Le style des graphes : lisse (courbe continue en image), pleine (l'aire remplie, en points), courbe (le trait), barres. */
export type Style = 'lisse' | 'pleine' | 'courbe' | 'barres'

declare module 'claude-code' {
  interface PluginState {
    'mac-sonde': {
      sortie: Sortie
      temperature: Lecture
      masque: boolean
      historique: Shaped<Historique>
      style: Style
    }
  }
}
