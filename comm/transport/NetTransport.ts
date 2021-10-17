import Transport from "./Transport.ts";
import { Address } from "../../util.ts";
export default class NetTransport implements Transport {
  constructor(
    public options: { port: number } & Record<string, unknown> = { port: 8008 },
  ) {}
  protocols = ["net"];
  async connect(
    addr: Address,
  ): Promise<Deno.Reader & Deno.Writer & Deno.Closer> {
    if (this.protocols.indexOf(addr.protocol) === -1) {
      throw new Error("Unsupported protocol");
    }
    return await Deno.connect({
      hostname: addr.host,
      port: addr.port,
    });
  }
  listen() {
    return Deno.listen(this.options);
  }
}
