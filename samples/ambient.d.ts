declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: {
    setItem: (key: string, value: string) => Promise<void>;
    getItem: (key: string) => Promise<string | null>;
    removeItem: (key: string) => Promise<void>;
  };
  export default AsyncStorage;
}

declare module "react-native-webview" {
  export const WebView: any;
}

declare module "react-native" {
  export const View: any;
  export const Text: any;
  export const Button: any;
  export const StyleSheet: any;
}
