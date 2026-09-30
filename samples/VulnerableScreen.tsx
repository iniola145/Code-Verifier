import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, Button } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { WebView } from "react-native-webview";

const STRIPE_SECRET_KEY = "sk_live_938102938102938102938102";

export default function VulnerableScreen({ route }: any) {
  const [userData, setUserData] = useState<any>(null);
  const [count, setCount] = useState(0);

  // Issue 1: React Infinite Re-render Loop
  useEffect(() => {
    setCount(count + 1);
  });

  // Issue 2: Insecure storage for sensitive auth token
  const handleLogin = async (token: string) => {
    await AsyncStorage.setItem("user_auth_token", token);
  };

  // Issue 3: Null dereference on user (simulating dynamic/untyped data)
  const renderProfile = () => {
    const user: any = null;
    return <Text>{user.email}</Text>;
  };

  // Issue 4: Deep-link taint flows into WebView HTML (AI-TAINT-001 + RN-SEC-002)
  const userHtml = route.params.untrustedHtml;

  return (
    <View style={styles.container}>
      <Text>Count: {count}</Text>
      <Button title="Login" onPress={() => handleLogin("jwt_12345")} />
      {renderProfile()}
      <WebView source={{ html: userHtml }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
});
