// Demo shop with an intentional bug.
// BUG: coupons are stored in upper case, but the lookup at checkout uses the raw
// input. "save20" (lower case) passes the apply step (which normalises), then
// "Place order" crashes with a TypeError because COUPONS["save20"] is undefined.
const PRICES = { kb: 120, mouse: 45 };
const COUPONS = { SAVE20: { rate: 0.2 } };

const cart = JSON.parse(localStorage.getItem('cart') || '[]');
const save = () => localStorage.setItem('cart', JSON.stringify(cart));
const total = () => cart.reduce((sum, sku) => sum + PRICES[sku], 0);
const renderCount = () => {
  document.getElementById('cart-count').textContent = `Cart: ${cart.length}`;
};
renderCount();

document.querySelectorAll('button.add').forEach((btn) => {
  btn.addEventListener('click', () => {
    cart.push(btn.dataset.sku);
    save();
    renderCount();
  });
});

const form = document.getElementById('checkout');
if (form) {
  const totalEl = document.getElementById('total');
  totalEl.textContent = `$${total()}`;

  document.getElementById('apply-coupon').addEventListener('click', () => {
    const code = form.coupon.value.trim();
    const status = document.getElementById('coupon-status');
    if (COUPONS[code.toUpperCase()]) {
      status.textContent = `Coupon ${code.toUpperCase()} applied`;
    } else {
      status.textContent = 'Invalid coupon';
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = form.coupon.value.trim();
    let amount = total();
    if (code) {
      amount = amount * (1 - COUPONS[code].rate); // 💥 TypeError for lower-case codes
    }
    document.getElementById('result').textContent = `Order placed! Charged $${amount.toFixed(2)}`;
    localStorage.removeItem('cart');
  });
}
