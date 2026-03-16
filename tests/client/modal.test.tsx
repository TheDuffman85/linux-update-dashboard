import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "../../client/components/Modal";

describe("Modal", () => {
  test("renders a close button for dismissible modals", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="Add System">
        <div>Body</div>
      </Modal>
    );

    expect(html).toContain("Close Add System modal");
  });

  test("hides the close button for locked modals", () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => {}} title="Approve SSH Host Key" dismissible={false}>
        <div>Body</div>
      </Modal>
    );

    expect(html).not.toContain("Close Approve SSH Host Key modal");
  });
});
