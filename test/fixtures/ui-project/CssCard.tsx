import styles from "./card.module.css";

export function CssCard() {
  document.querySelector(".label");
  document.querySelector(".ghost-query");
  return (
    <div className={styles.card}>
      <span className={styles.missing}>Card</span>
      <i className="legacy-hook" style={{ color: "red" }} />
    </div>
  );
}
