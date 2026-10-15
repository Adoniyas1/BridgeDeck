function h = yline(y, spec, label)
  % BridgeDeck fill-in for MATLAB's yline: a horizontal line across the current axes.
  if nargin < 2 || isempty(spec), spec = 'k-'; end
  ax = gca; held = ishold(ax); hold(ax, 'on');
  xl = xlim(ax); h = [];
  for k = 1:numel(y)
    h(end+1) = plot(ax, xl, [y(k) y(k)], spec);
    if nargin >= 3, text(ax, xl(1), y(k), label, 'VerticalAlignment', 'bottom'); end
  end
  xlim(ax, xl);
  if ~held, hold(ax, 'off'); end
end
