import PropTypes from "prop-types";

export function LegacyWidget({ label }) {
  return <div>{label}</div>;
}

LegacyWidget.propTypes = {
  label: PropTypes.string.isRequired,
};
