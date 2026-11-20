// Generated entry point; edit the canonical Session Hub source.
import {SessionHub} from "./hub.js";
export default class SessionView extends SessionHub {
  init(given,cx){super.init({...(given??{}),hubView:"recent"},cx);}
}
