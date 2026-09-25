import styles from "./card.module.css";

export function CssCard() {
  return <div className={styles.card}><span className={styles.missing}>Card</span></div>;
}
