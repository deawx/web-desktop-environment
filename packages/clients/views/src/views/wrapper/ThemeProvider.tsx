import React from "react";
import { Component } from "@react-fullstack/fullstack";
import ThemeProviderInterface from "@web-desktop-environment/interfaces/lib/views/ThemeProvider";
import { ThemeProvider as TP } from "@material-ui/styles";
import { Themes } from "@root/theme";
import { PureComponent } from "@components/pureComponent";

class ThemeProvider extends PureComponent<ThemeProviderInterface> {
	render() {
		if (this.props.theme === "custom" && this.props.customTheme) {
			return <TP theme={this.props.customTheme}>{this.props.children}</TP>;
		} else {
			return (
				<TP theme={Themes[this.props.theme as keyof typeof Themes]}>
					{this.props.children}
				</TP>
			);
		}
	}
}

export class EmptyThemeProvider extends Component<ThemeProviderInterface> {
	render() {
		return this.props.children || <></>;
	}
}

export default ThemeProvider;
