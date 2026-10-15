function ax = nexttile(varargin)
  % BridgeDeck fill-in for MATLAB's nexttile (see tiledlayout).
  g = getappdata(gcf, 'bridgedeck_tiles');
  if isempty(g), g = [2 2 0]; end
  if nargin >= 1 && isnumeric(varargin{end}), g(3) = varargin{end}; else, g(3) = g(3) + 1; end
  setappdata(gcf, 'bridgedeck_tiles', g);
  ax = subplot(g(1), g(2), g(3));
end
