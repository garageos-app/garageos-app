import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

type Props = {
  variant: 'certificato' | 'privato';
};

export function BadgeCertificato({ variant }: Props) {
  const isCertificato = variant === 'certificato';
  return (
    <View
      accessibilityLabel={isCertificato ? 'Intervento certificato' : 'Intervento privato'}
      style={[styles.pill, isCertificato ? styles.certificato : styles.privato]}
    >
      <Text style={[styles.text, isCertificato ? styles.textCertificato : styles.textPrivato]}>
        {isCertificato ? 'Certificato' : 'Privato'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  certificato: { backgroundColor: colors.certificato },
  privato: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.privato },
  text: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  textCertificato: { color: colors.primaryFg },
  textPrivato: { color: colors.privato },
});
