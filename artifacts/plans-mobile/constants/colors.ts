/**
 * Design tokens synced from the PDF Plans Viewer web app (index.css).
 * Steel-blue + amber palette for a professional construction field-tool feel.
 *
 * HSL values converted from the web app:
 *   background  hsl(215,20%,98%)  → #F5F7FB
 *   foreground  hsl(215,25%,15%)  → #1D2530
 *   primary     hsl(35,100%,55%)  → #FF9F1A  (amber)
 *   sidebar     hsl(215,25%,18%)  → #222C39
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#1D2530',
    tint: '#FF9F1A',

    background: '#F5F7FB',
    foreground: '#1D2530',

    card: '#FFFFFF',
    cardForeground: '#1D2530',

    primary: '#FF9F1A',
    primaryForeground: '#331500',

    secondary: '#333E4D',
    secondaryForeground: '#F0F2F5',

    muted: '#E8EAEE',
    mutedForeground: '#617084',

    accent: '#FF9F1A',
    accentForeground: '#331500',

    destructive: '#EF4343',
    destructiveForeground: '#FFFFFF',

    border: '#D3D8DE',
    input: '#D3D8DE',

    sidebar: '#222C39',
    sidebarForeground: '#D8E3EE',
  },

  dark: {
    text: '#E0E5EB',
    tint: '#FF9F1A',

    background: '#171D26',
    foreground: '#E0E5EB',

    card: '#1D2530',
    cardForeground: '#E0E5EB',

    primary: '#FF9F1A',
    primaryForeground: '#331500',

    secondary: '#333E4D',
    secondaryForeground: '#F0F2F5',

    muted: '#29313D',
    mutedForeground: '#98A3B3',

    accent: '#FF9F1A',
    accentForeground: '#331500',

    destructive: '#EF4343',
    destructiveForeground: '#FFFFFF',

    border: '#2D3F54',
    input: '#2D3F54',

    sidebar: '#111920',
    sidebarForeground: '#D8E3EE',
  },

  radius: 6,
};

export default colors;
