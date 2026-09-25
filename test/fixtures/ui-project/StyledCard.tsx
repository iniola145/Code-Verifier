import { cardStyles } from "./cardStyles";

export function StyledCard() {
  return <div style={cardStyles.root}><span style={cardStyles.missing}>Card</span></div>;
}
