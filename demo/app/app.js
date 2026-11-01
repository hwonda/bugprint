// Demo shop with an intentional, data-dependent bug.
//
// BUG: the coupon API answers 200 with `{ expired: true, discount: null }` for
// an expired coupon. The client only checks `res.ok`, shows "Coupon applied",
// and "Place order" then crashes on `discount.rate`.
// On a dev machine the coupon is still valid, so the bug "can't be reproduced"
// unless the recorded API response is replayed.
const PRICES = { kb: 120, mouse: 45 };

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

// Client-side search: filters the list and updates the URL without a page load.
const search = document.getElementById('search');
if (search) {
  const filter = (q) => {
    document.querySelectorAll('.products li').forEach((li) => {
      li.hidden = Boolean(q) && !li.dataset.name.includes(q.toLowerCase());
    });
  };
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  search.q.value = initial;
  filter(initial);
  search.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = search.q.value.trim();
    history.pushState({}, '', q ? `/?q=${encodeURIComponent(q)}` : '/');
    filter(q);
  });
  window.addEventListener('popstate', () => filter(new URLSearchParams(location.search).get('q') ?? ''));
}

const form = document.getElementById('checkout');
if (form) {
  let applied = null;
  document.getElementById('total').textContent = `$${total()}`;

  document.getElementById('apply-coupon').addEventListener('click', async () => {
    const code = form.coupon.value.trim();
    const status = document.getElementById('coupon-status');
    const res = await fetch(`/api/coupons/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (res.ok) {
      applied = data;
      status.textContent = `Coupon ${data.code} applied`;
    } else {
      applied = null;
      status.textContent = data.expired ? 'Coupon expired' : 'Invalid coupon';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let amount = total();
    if (applied) amount = amount * (1 - applied.discount.rate); // 💥 discount is null for expired coupons
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ items: cart, amount }) });
    document.getElementById('result').textContent = `Order placed! Charged $${amount.toFixed(2)}`;
    localStorage.removeItem('cart');
  });
}
