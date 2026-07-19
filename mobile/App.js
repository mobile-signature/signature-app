import React, { useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';

// Native shell around the same web app. It exists so you can ship to the App
// Store / Play Store; the PWA is the primary distribution path and needs none
// of this. Set SERVER_URL in mobile/app.json -> expo.extra.serverUrl.
const SERVER_URL = Constants.expoConfig?.extra?.serverUrl || 'https://example.com';

export default function App() {
  const webRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const canGoBack = useRef(false);

  React.useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  if (error) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.fill}>
          <ScrollView
            contentContainerStyle={styles.center}
            refreshControl={<RefreshControl refreshing={false} onRefresh={() => setError(null)} />}
          >
            <Text style={styles.title}>Cannot reach the server</Text>
            <Text style={styles.body}>{SERVER_URL}</Text>
            <Text style={styles.body}>Pull down to retry.</Text>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
        <WebView
          ref={webRef}
          source={{ uri: SERVER_URL }}
          originWhitelist={['https://*', 'http://localhost*']}
          allowsInlineMediaPlayback
          // Needed so the <input type="file"> PDF picker works on Android.
          allowFileAccess
          javaScriptEnabled
          domStorageEnabled
          pullToRefreshEnabled
          onLoadEnd={() => setLoading(false)}
          onError={() => setError('load')}
          onHttpError={({ nativeEvent }) => {
            if (nativeEvent.statusCode >= 500) setError('server');
          }}
          onNavigationStateChange={(nav) => {
            canGoBack.current = nav.canGoBack;
          }}
        />
        {loading && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#3d7dfd" />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0f1216' },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#eef2f7', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  body: { color: '#97a3b4', fontSize: 14, textAlign: 'center', marginTop: 4 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f1216',
  },
});
