/**
 * 主题状态管理
 * 从原项目 src/modules/theme.js 迁移
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '@/types';
import { STORAGE_KEY_THEME } from '@/utils/constants';

type ResolvedTheme = 'light' | 'dark';
type AppliedTheme = ResolvedTheme | 'white';

interface ThemeState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  initializeTheme: () => () => void;
}

const getSystemTheme = (): ResolvedTheme => {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
};

const resolveAutoTheme = (): AppliedTheme => {
  return getSystemTheme() === 'dark' ? 'dark' : 'white';
};

const normalizeResolvedTheme = (theme: AppliedTheme): ResolvedTheme => {
  return theme === 'dark' ? 'dark' : 'light';
};

const resolveTheme = (theme: Theme): AppliedTheme => {
  if (theme === 'auto') {
    return resolveAutoTheme();
  }
  if (theme === 'white') {
    return 'white';
  }
  return theme;
};

const applyTheme = (resolved: AppliedTheme) => {
  if (resolved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    return;
  }

  if (resolved === 'white') {
    document.documentElement.setAttribute('data-theme', 'white');
    return;
  }

  document.documentElement.removeAttribute('data-theme');
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'auto',
      resolvedTheme: 'light',

      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({
          theme,
          resolvedTheme: normalizeResolvedTheme(resolved),
        });
      },

      // The panel is dark-only (the theme menu was removed), so a saved theme is ignored.
      initializeTheme: () => {
        get().setTheme('dark');
        return () => {};
      },
    }),
    {
      name: STORAGE_KEY_THEME,
    }
  )
);
