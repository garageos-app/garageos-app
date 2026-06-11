// Dynamic Expo config (replaces app.json). The only dynamic piece is
// android.googleServicesFile: on EAS cloud builds the FCM client config is
// injected via the GOOGLE_SERVICES_JSON file environment variable so the
// file stays out of the public repo; locally it falls back to
// ./google-services.json (gitignored).
module.exports = {
  expo: {
    name: 'GarageOS',
    slug: 'garageos-mobile',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: 'garageos',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    ios: {
      bundleIdentifier: 'com.garageos.mobile',
      supportsTablet: false,
    },
    android: {
      package: 'it.garageos.mobile',
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
      permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-camera',
        {
          cameraPermission:
            'Consenti a GarageOS di usare la camera per scansionare il QR del tag veicolo.',
        },
      ],
      'expo-notifications',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {
        origin: false,
      },
      eas: {
        projectId: 'c97d3080-7775-4979-8e5f-7f2e9153205b',
      },
    },
    owner: 'michele.matula',
  },
};
