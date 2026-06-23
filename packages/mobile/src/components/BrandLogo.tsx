import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme/colors';
// Static asset imports — Metro resolves these at bundle time (literal paths).
// Both marks load; the tone prop selects which one renders.
import MARK_WHITE from '../../assets/icon-mark-white.png';
import MARK_BLUE from '../../assets/icon-mark-blue.png';

interface BrandLogoProps {
  /** Surface adaptation: `onDark` (white) for the blue hero/splash, `onLight`
   *  (blue) for white navigation headers. */
  tone: 'onLight' | 'onDark';
  /** Mark square in px. Default 40. */
  size?: number;
  /** Render the "GarageOS" wordmark next to the mark. Default true. */
  showWordmark?: boolean;
  /** Optional tagline rendered below the wordmark. */
  tagline?: string;
  /** Stack direction. `vertical` for the login hero, `horizontal` for headers. */
  orientation?: 'horizontal' | 'vertical';
}

/**
 * Brand lockup: the gauge-g mark plus the "GarageOS" wordmark and an optional
 * tagline. Presentational — no navigation or state.
 */
export function BrandLogo({
  tone,
  size = 40,
  showWordmark = true,
  tagline,
  orientation = 'horizontal',
}: BrandLogoProps) {
  const onDark = tone === 'onDark';
  const mark = onDark ? MARK_WHITE : MARK_BLUE;
  const textColor = onDark ? '#FFFFFF' : colors.fg;
  const taglineColor = onDark ? 'rgba(255,255,255,0.85)' : colors.muted;
  const vertical = orientation === 'vertical';

  return (
    <View style={vertical ? styles.column : styles.row}>
      <Image
        source={mark}
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        style={{ width: size, height: size }}
      />
      {showWordmark ? (
        <View style={vertical ? styles.textColumn : styles.textRow}>
          <Text style={[styles.wordmark, { color: textColor, fontSize: vertical ? 28 : 18 }]}>
            GarageOS
          </Text>
          {tagline ? (
            <Text style={[styles.tagline, { color: taglineColor }]}>{tagline}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  column: { flexDirection: 'column', alignItems: 'center', gap: 8 },
  textRow: { justifyContent: 'center' },
  textColumn: { alignItems: 'center', gap: 4 },
  wordmark: { fontWeight: '700', letterSpacing: -0.5 },
  tagline: { fontSize: 14, textAlign: 'center' },
});
