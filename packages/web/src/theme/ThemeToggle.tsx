import { Moon, Sun } from 'lucide-react';
import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Cambia tema chiaro/scuro"
      aria-pressed={isDark}
      className="inline-flex items-center justify-center h-9 w-9 rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 transition"
    >
      {isDark ? (
        <Sun size={18} data-theme-icon="sun" aria-hidden="true" />
      ) : (
        <Moon size={18} data-theme-icon="moon" aria-hidden="true" />
      )}
    </button>
  );
}
